/**
 * Production outline registry injection.
 *
 * The `WorkbenchController` fills the UI-owned structural port
 * `WorkbenchOutlineProviderLike` without importing `@froglight/ui`: a real
 * `InMemoryOutlineRegistry` with the first-party composition plus a
 * bound `getOutlineModel` resolving live session models with their
 * dirty-aware outline key (`contentRevision` + `contentSequence`;
 * identity is the document id, supplied by the shell).
 *
 * Covers: shared composition parity, structured models + revision per family
 * (blockpage/notebook/latex), Markdown staying on the text projection
 * (null model), unknown documents resolving to null, stable-revision
 * referential stability, commit->outline refresh without remount
 * (notebook H1 commits and LaTeX section inserts advance the key
 * and notify the shell; stable keys stay referentially stable),
 * unknown-kind fail-closed with the structured
 * error code, slot invalidation on tab close, and the registration
 * lifecycle (activate → one per kind, dispose → zero).
 *
 * Headless and engine-free: plain models only, no editor/DOM/host types.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ErrorCodes,
  InMemorySearchService,
  blockPageKind,
  blockPageKindId,
  emptyNotebook,
  headingBlock,
  isNavigablePage,
  latexKind,
  latexKindId,
  latexModel,
  markdownKind,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  notebookKind,
  notebookKindId,
  notebookPage,
  textObject,
  workspacePath,
  type BlockPageModel,
  type DocumentEditorProvider,
  type DocumentKindDescriptor,
  type DocumentKindId,
  type DocumentReaderProvider,
  type DocumentSession,
  type NotebookModel,
} from '@froglight/foundation';
import { createApp, createWorkbenchController } from './index.js';
import { firstPartyOutlineExtractors } from './outline/registry.js';

function mockEditorProvider(kindId: DocumentKindId): DocumentEditorProvider {
  return {
    id: `test-outline-editor-${String(kindId)}`,
    kindIds: [kindId],
    createEditor() {
      return {
        focus() {
          // No-op test double.
        },
        hasFocus() {
          return false;
        },
        execCommand() {
          return false;
        },
        setReadOnly() {
          // No-op test double.
        },
        flush() {
          // No-op test double.
        },
        destroy() {
          // No-op test double.
        },
      };
    },
  };
}

async function setup(
  // Mirrors `ProfileDocumentKind` (`DocumentKindDescriptor<any>`): one
  // heterogeneous list of family descriptors per test.
  kinds: readonly DocumentKindDescriptor<any>[],
): Promise<{
  readonly app: Awaited<ReturnType<typeof createApp>>;
  readonly controller: ReturnType<typeof createWorkbenchController>;
}> {
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [...kinds],
    documentEditorProviders: kinds.map((kind) =>
      mockEditorProvider(kind.id as DocumentKindId),
    ),
  });
  const controller = createWorkbenchController(app);
  return { app, controller };
}

function blockModel(): BlockPageModel {
  return {
    formatVersion: 1,
    meta: {},
    rootOrder: ['h1'],
    blocks: { h1: headingBlock('h1', 1, [{ text: 'Overview' }]) },
  };
}

function notebookModel(): NotebookModel {
  const model = emptyNotebook('Field notes');
  const page = notebookPage('page-a', { label: 'Site A' });
  page.surface.objects['t1'] = textObject('t1', {
    x: 10,
    y: 50,
    text: 'Canopy\nsecond line',
    role: 'heading',
  });
  page.surface.order.push('t1');
  model.pages[page.id] = page;
  model.pageOrder.push(page.id);
  return model;
}

describe('workbench outline injection', () => {
  it('registers the shared first-party extractor composition', async () => {
    const { app, controller } = await setup([
      markdownKind,
      blockPageKind,
      notebookKind,
      latexKind,
    ]);
    try {
      expect(controller.outlineRegistry.list()).toEqual(
        firstPartyOutlineExtractors,
      );
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('resolves live blockpage models with the session contentRevision', async () => {
    const { app, controller } = await setup([
      blockPageKind,
    ]);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: blockPageKindId,
        path: workspacePath('site.blockpage'),
        initialModel: blockModel(),
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});

      const resolved = controller.getOutlineModel(documentId);
      expect(resolved).not.toBeNull();
      const session = workspace.getOpenDocument(ref.documentId);
      expect(session).not.toBeNull();
      // dirty-aware key: stable base plus the content sequence.
      expect(resolved!.revision).toBe(
        `${session!.contentRevision}:${session!.contentSequence}`,
      );
      expect(typeof resolved!.revision).toBe('string');

      const rows = controller.outlineRegistry.getOutline(
        blockPageKindId,
        resolved!.model,
        resolved!.revision,
        { documentIdentity: documentId },
      );
      expect(rows.map((row) => row.label)).toEqual(['Overview']);
      expect(rows[0]).toMatchObject({
        id: 'h1',
        address: 'h1',
        level: 1,
      });
      // Stable revision yields the same frozen reference (no recompute).
      const again = controller.outlineRegistry.getOutline(
        blockPageKindId,
        resolved!.model,
        resolved!.revision,
        { documentIdentity: documentId },
      );
      expect(again).toBe(rows);
      expect(Object.isFrozen(rows)).toBe(true);
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('resolves live notebook models with page + object rows', async () => {
    const { app, controller } = await setup([
      notebookKind,
    ]);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: notebookKindId,
        path: workspacePath('notes/field.notebook'),
        initialModel: notebookModel(),
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});

      const resolved = controller.getOutlineModel(documentId);
      expect(resolved).not.toBeNull();
      // dirty-aware key: stable base plus the content sequence.
      expect(resolved!.revision).toBe(
        `${workspace.getOpenDocument(ref.documentId)!.contentRevision}:${workspace.getOpenDocument(ref.documentId)!.contentSequence}`,
      );
      const rows = controller.outlineRegistry.getOutline(
        notebookKindId,
        resolved!.model,
        resolved!.revision,
        { documentIdentity: documentId },
      );
      expect(rows.map((row) => row.label)).toEqual(['Canopy']);
      expect(rows[0]).toMatchObject({
        id: 'page-a:t1',
        address: 'page-a',
        level: 3,
      });
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('resolves live latex models with section rows', async () => {
    const { app, controller } = await setup([
      latexKind,
    ]);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('paper.tex'),
        initialModel: latexModel(
          '\\section{Intro}\n\\subsection{Background}\n',
        ),
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});

      const resolved = controller.getOutlineModel(documentId);
      expect(resolved).not.toBeNull();
      // dirty-aware key: stable base plus the content sequence.
      expect(resolved!.revision).toBe(
        `${workspace.getOpenDocument(ref.documentId)!.contentRevision}:${workspace.getOpenDocument(ref.documentId)!.contentSequence}`,
      );
      const rows = controller.outlineRegistry.getOutline(
        latexKindId,
        resolved!.model,
        resolved!.revision,
        { documentIdentity: documentId },
      );
      expect(rows.map((row) => row.label)).toEqual([
        'Intro',
        'Background',
      ]);
      expect(rows.map((row) => row.level)).toEqual([1, 2]);
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('keeps Markdown on the text projection (null model, live text intact)', async () => {
    const { app, controller } = await setup([
      markdownKind,
    ]);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: markdownKindId,
        path: workspacePath('notes/field.md'),
        initialModel: markdownModel('# Field notes\n\n## Habitat\n'),
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});

      // No structured model: the shell derives Markdown from the pane text
      // projection so the outline keeps updating per keystroke.
      expect(controller.getOutlineModel(documentId)).toBeNull();
      expect(controller.getPaneText('main')).toBe(
        '# Field notes\n\n## Habitat\n',
      );
      // The real registry still serves Markdown through the text path.
      const rows = controller.outlineRegistry.getOutline(
        markdownKindId,
        '# Field notes\n\n## Habitat\n',
        'rev-md-1',
        { documentIdentity: documentId },
      );
      expect(rows.map((row) => row.label)).toEqual([
        'Field notes',
        'Habitat',
      ]);
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('returns null for unknown documents and survives unbound reads', async () => {
    const { app, controller } = await setup([
      latexKind,
    ]);
    try {
      expect(controller.getOutlineModel('doc-missing')).toBeNull();
      // The shell reads the provider unbound (`provider.getOutlineModel`
      // called as a bare function): the arrow property must survive that.
      const unbound = controller.getOutlineModel;
      expect(unbound('doc-missing')).toBeNull();

      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('paper.tex'),
        initialModel: latexModel('\\section{Intro}\n'),
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});
      expect(unbound(documentId)).not.toBeNull();
      expect(unbound(documentId)!.revision).toBe(
        controller.getOutlineModel(documentId)!.revision,
      );
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('fails closed for unknown kinds with the structured error code', async () => {
    const { app, controller } = await setup([
      markdownKind,
    ]);
    try {
      let code: unknown = null;
      try {
        controller.outlineRegistry.getOutline(
          'test.unknown' as never,
          {},
          'rev-1',
          { documentIdentity: 'doc-x' },
        );
      } catch (error) {
        code = (error as { code?: unknown }).code;
      }
      expect(code).toBe(ErrorCodes.UNKNOWN_OUTLINE_KIND);
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('invalidates the document slot on tab close', async () => {
    const { app, controller } = await setup([
      blockPageKind,
    ]);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: blockPageKindId,
        path: workspacePath('site.blockpage'),
        initialModel: blockModel(),
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});

      const resolved = controller.getOutlineModel(documentId)!;
      controller.outlineRegistry.getOutline(
        blockPageKindId,
        resolved.model,
        resolved.revision,
        { documentIdentity: documentId },
      );
      const before = controller.outlineRegistry.stats();
      expect(before.misses).toBe(1);
      // Revision hit: no recompute.
      controller.outlineRegistry.getOutline(
        blockPageKindId,
        resolved.model,
        resolved.revision,
        { documentIdentity: documentId },
      );
      expect(controller.outlineRegistry.stats().hits).toBe(before.hits + 1);

      const tabId =
        controller.paneStates().find((pane) => pane.pane === 'main')
          ?.activeTab ?? documentId;
      await controller.closeTab('main', tabId);
      expect(controller.getOutlineModel(documentId)).toBeNull();
      // The slot is gone: the same revision recomputes instead of hitting.
      const misses = controller.outlineRegistry.stats().misses;
      controller.outlineRegistry.getOutline(
        blockPageKindId,
        resolved.model,
        resolved.revision,
        { documentIdentity: documentId },
      );
      expect(controller.outlineRegistry.stats().misses).toBe(misses + 1);
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('refreshes the notebook outline on an in-place H1 commit without remount', async () => {
    const { app, controller } = await setup([
      notebookKind,
    ]);
    try {
      const workspace = app.getWorkspace()!;
      // Start with a page but no heading objects: the outline has only the
      // empty outline until the heading commit lands.
      const initial = emptyNotebook('Field notes');
      const page = notebookPage('page-a', { label: 'Site A' });
      initial.pages[page.id] = page;
      initial.pageOrder.push(page.id);
      const ref = await workspace.createDocument({
        kindId: notebookKindId,
        path: workspacePath('notes/field.notebook'),
        initialModel: initial,
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});

      let notifications = 0;
      const subscription = controller.onDidChange(() => {
        notifications += 1;
      });
      try {
        const before = controller.getOutlineModel(documentId)!;
        const beforeRows = controller.outlineRegistry.getOutline(
          notebookKindId,
          before.model,
          before.revision,
          { documentIdentity: documentId },
        );
        expect(beforeRows).toEqual([]);

        // Stable key without edits: same revision value, same frozen rows.
        const reread = controller.getOutlineModel(documentId)!;
        expect(reread.revision).toBe(before.revision);
        expect(
          controller.outlineRegistry.getOutline(
            notebookKindId,
            reread.model,
            reread.revision,
            { documentIdentity: documentId },
          ),
        ).toBe(beforeRows);

        // In-place surface commit: mutate the live model and markDirty (no
        // remount, no tab switch, no save) — the H1 path (`setSelectionStyle`
        // in production) that left stale.
        const session = workspace.getOpenDocument(ref.documentId)!;
        const live = session.model as NotebookModel;
        const seen = notifications;
        const entry = live.pages['page-a'];
        if (!isNavigablePage(entry)) throw new Error('test page is not navigable');
        entry.surface.objects['t1'] = textObject('t1', {
          x: 10,
          y: 50,
          text: 'Canopy\nsecond line',
          role: 'heading',
        });
        entry.surface.order.push('t1');
        session.markDirty();

        // The content commit bumped the shell and minted a new outline key.
        expect(notifications).toBeGreaterThan(seen);
        const after = controller.getOutlineModel(documentId)!;
        expect(after.revision).not.toBe(before.revision);
        const afterRows = controller.outlineRegistry.getOutline(
          notebookKindId,
          after.model,
          after.revision,
          { documentIdentity: documentId },
        );
        expect(afterRows.map((row) => row.label)).toEqual(['Canopy']);
        expect(afterRows[0]).toMatchObject({
          id: 'page-a:t1',
          address: 'page-a',
          level: 3,
        });
        expect(Object.isFrozen(afterRows)).toBe(true);
        // The new stable key hits without recompute.
        expect(
          controller.outlineRegistry.getOutline(
            notebookKindId,
            after.model,
            after.revision,
            { documentIdentity: documentId },
          ),
        ).toBe(afterRows);
      } finally {
        subscription.dispose();
      }
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('refreshes the latex outline when a section is inserted while dirty', async () => {
    const { app, controller } = await setup([
      latexKind,
    ]);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('paper.tex'),
        initialModel: latexModel('\\section{Intro}\n'),
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});

      let notifications = 0;
      const subscription = controller.onDidChange(() => {
        notifications += 1;
      });
      try {
        const before = controller.getOutlineModel(documentId)!;
        const beforeRows = controller.outlineRegistry.getOutline(
          latexKindId,
          before.model,
          before.revision,
          { documentIdentity: documentId },
        );
        expect(beforeRows.map((row) => row.label)).toEqual(['Intro']);

        // LaTeX typing: in-place raw mutation plus markDirty while already
        // dirty must still advance the outline key (the dirty flag never
        // flips twice, so the sequence — not the flag — drives freshness).
        const session = workspace.getOpenDocument(ref.documentId)!;
        const seen = notifications;
        (session.model as unknown as { raw: string }).raw +=
          '\n\\section{Methods}\n';
        session.markDirty();
        expect(notifications).toBeGreaterThan(seen);
        const afterFirst = controller.getOutlineModel(documentId)!;
        expect(afterFirst.revision).not.toBe(before.revision);
        const seenAgain = notifications;
        (session.model as unknown as { raw: string }).raw +=
          '\\subsection{Setup}\n';
        session.markDirty();
        expect(notifications).toBeGreaterThan(seenAgain);
        const afterSecond = controller.getOutlineModel(documentId)!;
        expect(afterSecond.revision).not.toBe(afterFirst.revision);

        const afterRows = controller.outlineRegistry.getOutline(
          latexKindId,
          afterSecond.model,
          afterSecond.revision,
          { documentIdentity: documentId },
        );
        expect(afterRows.map((row) => row.label)).toEqual([
          'Intro',
          'Methods',
          'Setup',
        ]);
        expect(afterRows.map((row) => row.level)).toEqual([1, 1, 2]);
      } finally {
        subscription.dispose();
      }
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('drops extractor registrations on dispose (activate -> 1, dispose -> 0)', async () => {
    const { app, controller } = await setup([
      markdownKind,
    ]);
    try {
      expect(controller.outlineRegistry.list()).toHaveLength(5);
    } finally {
      await controller.dispose();
      await app.dispose();
    }
    expect(controller.outlineRegistry.list()).toHaveLength(0);
  });

  it('omits the revision for legacy doubles so mutated content recomputes', async () => {
    const { app, controller } = await setup([blockPageKind]);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: blockPageKindId,
        path: workspacePath('site.blockpage'),
        initialModel: blockModel(),
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});

      const before = controller.getOutlineModel(documentId)!;
      expect(before.revision).toBeDefined();
      const beforeRows = controller.outlineRegistry.getOutline(
        blockPageKindId,
        before.model,
        before.revision,
        { documentIdentity: documentId },
      );
      expect(beforeRows.map((row) => row.label)).toEqual(['Overview']);

      const session = workspace.getOpenDocument(ref.documentId)!;
      const live = session.model as BlockPageModel;
      live.blocks['h2'] = headingBlock('h2', 2, [{ text: 'Details' }]);
      live.rootOrder.push('h2');

      // Simulate a legacy double without a numeric sequence: the
      // controller must omit the revision (content-hash fallback) instead
      // of returning the bare base which would cache-hit stale rows.
      Object.defineProperty(session, 'contentSequence', {
        value: undefined,
        configurable: true,
      });
      const legacy = controller.getOutlineModel(documentId)!;
      expect(legacy.revision).toBeUndefined();
      const legacyRows = controller.outlineRegistry.getOutline(
        blockPageKindId,
        legacy.model,
        legacy.revision,
        { documentIdentity: documentId },
      );
      expect(legacyRows.map((row) => row.label)).toEqual([
        'Overview',
        'Details',
      ]);
      expect(legacyRows).not.toBe(beforeRows);

      // An undefined base with a numeric sequence must never mint
      // `undefined:N`: it also omits the revision.
      Object.defineProperty(session, 'contentRevision', {
        value: undefined,
        configurable: true,
      });
      Object.defineProperty(session, 'contentSequence', {
        value: 3,
        configurable: true,
      });
      const undefinedBase = controller.getOutlineModel(documentId)!;
      expect(undefinedBase.revision).toBeUndefined();
      // Must never mint the string 'undefined:N'.
      expect(undefinedBase.revision).not.toBe('undefined:3');
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('contains a throwing reader update: markDirty still notifies and advances the key', async () => {
    const editorProvider = mockEditorProvider(notebookKindId);
    let shouldThrow = false;
    const throwingReader: DocumentReaderProvider = {
      id: 'test-throwing-reader-notebook',
      kindIds: [notebookKindId],
      createReader() {
        return {
          update() {
            if (shouldThrow) throw new Error('reader boom');
          },
          destroy() {
            // No-op test double.
          },
        };
      },
    };
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [notebookKind],
      documentEditorProviders: [editorProvider],
      documentReaderProviders: [throwingReader],
    });
    const controller = createWorkbenchController(app);
    const warned: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warned.push(args);
    };
    try {
      const workspace = app.getWorkspace()!;
      const initial = emptyNotebook('Field notes');
      const page = notebookPage('page-a', { label: 'Site A' });
      initial.pages[page.id] = page;
      initial.pageOrder.push(page.id);
      const ref = await workspace.createDocument({
        kindId: notebookKindId,
        path: workspacePath('notes/field.notebook'),
        initialModel: initial,
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});
      controller.setReaderHost('main', {});
      const tabId =
        controller.paneStates().find((pane) => pane.pane === 'main')
          ?.activeTab ?? documentId;
      controller.setTabMode('main', tabId, 'reading');

      let notifications = 0;
      const subscription = controller.onDidChange(() => {
        notifications += 1;
      });
      try {
        const before = controller.getOutlineModel(documentId)!;
        const seen = notifications;
        shouldThrow = true;
        const session = workspace.getOpenDocument(ref.documentId)!;
        const live = session.model as NotebookModel;
        const entry = live.pages['page-a'];
        if (!isNavigablePage(entry)) throw new Error('test page is not navigable');
        entry.surface.objects['t1'] = textObject('t1', {
          x: 10,
          y: 50,
          text: 'Canopy',
          role: 'heading',
        });
        entry.surface.order.push('t1');
        let threw = false;
        try {
          session.markDirty();
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(notifications).toBeGreaterThan(seen);
        const after = controller.getOutlineModel(documentId)!;
        expect(after.revision).not.toBe(before.revision);
        const afterRows = controller.outlineRegistry.getOutline(
          notebookKindId,
          after.model,
          after.revision,
          { documentIdentity: documentId },
        );
        expect(afterRows.map((row) => row.label)).toEqual(['Canopy']);
      } finally {
        subscription.dispose();
      }
      expect(
        warned.some((args) =>
          String(args[0]).includes('[workbench-controller]'),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
      await controller.dispose();
      await app.dispose();
    }
  });

  it('tolerates markDirty during save with a live reader', async () => {
    const editorProvider = mockEditorProvider(notebookKindId);
    let readerUpdates = 0;
    const liveReader: DocumentReaderProvider = {
      id: 'test-live-reader-notebook',
      kindIds: [notebookKindId],
      createReader() {
        return {
          update() {
            readerUpdates += 1;
          },
          destroy() {
            // No-op test double.
          },
        };
      },
    };
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [notebookKind],
      documentEditorProviders: [editorProvider],
      documentReaderProviders: [liveReader],
    });
    const controller = createWorkbenchController(app);
    try {
      const workspace = app.getWorkspace()!;
      const initial = emptyNotebook('Field notes');
      const page = notebookPage('page-a', { label: 'Site A' });
      initial.pages[page.id] = page;
      initial.pageOrder.push(page.id);
      const ref = await workspace.createDocument({
        kindId: notebookKindId,
        path: workspacePath('notes/field.notebook'),
        initialModel: initial,
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});
      controller.setReaderHost('main', {});
      const tabId =
        controller.paneStates().find((pane) => pane.pane === 'main')
          ?.activeTab ?? documentId;
      controller.setTabMode('main', tabId, 'reading');
      const updatesBefore = readerUpdates;
      expect(updatesBefore).toBeGreaterThanOrEqual(1);

      let notifications = 0;
      const subscription = controller.onDidChange(() => {
        notifications += 1;
      });
      try {
        const session = workspace.getOpenDocument(ref.documentId)!;
        const before = controller.getOutlineModel(documentId)!;
        const seen = notifications;
        const savePromise = session.save();
        const live = session.model as NotebookModel;
        const entry = live.pages['page-a'];
        if (!isNavigablePage(entry)) throw new Error('test page is not navigable');
        entry.surface.objects['t1'] = textObject('t1', {
          x: 10,
          y: 50,
          text: 'Canopy',
          role: 'heading',
        });
        entry.surface.order.push('t1');
        let threw = false;
        try {
          session.markDirty();
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        const result = await savePromise;
        expect(result.committed).toBe(true);
        expect(notifications).toBeGreaterThan(seen);
        expect(readerUpdates).toBeGreaterThan(updatesBefore);
        const after = controller.getOutlineModel(documentId)!;
        expect(after.revision).not.toBe(before.revision);
        const afterRows = controller.outlineRegistry.getOutline(
          notebookKindId,
          after.model,
          after.revision,
          { documentIdentity: documentId },
        );
        expect(afterRows.map((row) => row.label)).toEqual(['Canopy']);
      } finally {
        subscription.dispose();
      }
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('advances the outline on undo and reverts rows', async () => {
    let undoImpl: (() => boolean) | null = null;
    let capturedSession: DocumentSession | null = null;
    const undoableEditor: DocumentEditorProvider = {
      id: 'test-undoable-editor-notebook',
      kindIds: [notebookKindId],
      createEditor(input) {
        capturedSession = input.session as DocumentSession;
        return {
          focus() {
            // No-op test double.
          },
          hasFocus() {
            return false;
          },
          execCommand(command: string) {
            if (command === 'undo' && undoImpl !== null) return undoImpl();
            return false;
          },
          setReadOnly() {
            // No-op test double.
          },
          flush() {
            // No-op test double.
          },
          destroy() {
            // No-op test double.
          },
        };
      },
    };
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [notebookKind],
      documentEditorProviders: [undoableEditor],
    });
    const controller = createWorkbenchController(app);
    try {
      const workspace = app.getWorkspace()!;
      const initial = emptyNotebook('Field notes');
      const page = notebookPage('page-a', { label: 'Site A' });
      initial.pages[page.id] = page;
      initial.pageOrder.push(page.id);
      const ref = await workspace.createDocument({
        kindId: notebookKindId,
        path: workspacePath('notes/field.notebook'),
        initialModel: initial,
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});
      expect(capturedSession).not.toBeNull();

      let notifications = 0;
      const subscription = controller.onDidChange(() => {
        notifications += 1;
      });
      try {
        const pristine = controller.getOutlineModel(documentId)!;
        const pristineRows = controller.outlineRegistry.getOutline(
          notebookKindId,
          pristine.model,
          pristine.revision,
          { documentIdentity: documentId },
        );
        expect(pristineRows).toEqual([]);

        const session = workspace.getOpenDocument(ref.documentId)!;
        const seenCommit = notifications;
        const live = session.model as NotebookModel;
        const entry = live.pages['page-a'];
        if (!isNavigablePage(entry)) throw new Error('test page is not navigable');
        entry.surface.objects['t1'] = textObject('t1', {
          x: 10,
          y: 50,
          text: 'Canopy',
          role: 'heading',
        });
        entry.surface.order.push('t1');
        session.markDirty();
        expect(notifications).toBeGreaterThan(seenCommit);
        const committed = controller.getOutlineModel(documentId)!;
        expect(committed.revision).not.toBe(pristine.revision);
        const committedRows = controller.outlineRegistry.getOutline(
          notebookKindId,
          committed.model,
          committed.revision,
          { documentIdentity: documentId },
        );
        expect(committedRows.map((row) => row.label)).toEqual(['Canopy']);

        const seenUndo = notifications;
        undoImpl = () => {
          const target = live.pages['page-a'];
          if (!isNavigablePage(target)) return false;
          delete target.surface.objects['t1'];
          target.surface.order = target.surface.order.filter(
            (id) => id !== 't1',
          );
          session.markDirty();
          return true;
        };
        const handled = controller.execEditorCommand('undo');
        expect(handled).toBe(true);
        expect(notifications).toBeGreaterThan(seenUndo);
        const undone = controller.getOutlineModel(documentId)!;
        expect(undone.revision).not.toBe(committed.revision);
        expect(undone.revision).not.toBe(pristine.revision);
        const undoneRows = controller.outlineRegistry.getOutline(
          notebookKindId,
          undone.model,
          undone.revision,
          { documentIdentity: documentId },
        );
        expect(undoneRows).toEqual([]);
      } finally {
        subscription.dispose();
      }
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('coalesces sustained typing double notifies to one shell bump per commit', async () => {
    // each LaTeX keystroke historically fired TWO shell notifies
    // (session content + editor tools) plus a dirty+content pair on the
    // first commit, spamming `Maximum update depth exceeded` on long docs.
    // The controller must coalesce the redundant same-sequence second bump
    // while every real commit still notifies synchronously once.
    const toolListeners = new Set<() => void>();
    const capturing: DocumentEditorProvider = {
      id: 'test-latex-double-notify',
      kindIds: [latexKindId],
      createEditor() {
        return {
          focus() {
            // No-op test double.
          },
          hasFocus() {
            return false;
          },
          execCommand() {
            return false;
          },
          setReadOnly() {
            // No-op test double.
          },
          flush() {
            // No-op test double.
          },
          destroy() {
            // No-op test double.
          },
          tools: {
            snapshot: () =>
              ({ context: 'LaTeX', controls: [] }) as never,
            execute: () => false,
            onDidChange: (listener: () => void) => {
              toolListeners.add(listener);
              return {
                dispose: () => {
                  toolListeners.delete(listener);
                },
              };
            },
          },
        } as unknown as ReturnType<DocumentEditorProvider['createEditor']>;
      },
    };
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [latexKind],
      documentEditorProviders: [capturing],
    });
    const controller = createWorkbenchController(app);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('paper.tex'),
        initialModel: latexModel('\\section{Intro}\n'),
      });
      const documentId = String(ref.documentId);
      await controller.openDocument(documentId, {});
      expect(toolListeners.size).toBeGreaterThan(0);

      let notifications = 0;
      const subscription = controller.onDidChange(() => {
        notifications += 1;
      });
      try {
        const session = workspace.getOpenDocument(ref.documentId)!;
        const ITERATIONS = 32;
        const seen = notifications;
        let threw = false;
        for (let index = 0; index < ITERATIONS; index += 1) {
          try {
            (session.model as unknown as { raw: string }).raw +=
              `\n% typing ${index}\n`;
            session.markDirty();
            // Old LaTeX path fired a synchronous tools change in the same
            // tick (the redundant second bump). The coalescing must skip it.
            for (const listener of [...toolListeners]) listener();
          } catch {
            threw = true;
          }
        }
        expect(threw).toBe(false);
        // Bounded: at most one shell bump per commit (dirty+content+tools
        // triple coalesced). Without the fix this loop yields ~3x (first)
        // + 2x (rest) ≈ 60+ notifies and spams update-depth on long docs.
        expect(notifications - seen).toBeLessThanOrEqual(ITERATIONS);
        // Freshness preserved: every commit still notified once (not
        // collapsed to a single tick bump), so the count is exactly one
        // per commit and the outline key advanced.
        expect(notifications - seen).toBe(ITERATIONS);
        const resolved = controller.getOutlineModel(documentId)!;
        expect(resolved.revision).toBeDefined();
        const rows = controller.outlineRegistry.getOutline(
          latexKindId,
          resolved.model,
          resolved.revision,
          { documentIdentity: documentId },
        );
        expect(rows.map((row) => row.label)).toContain('Intro');
        // Let the coalescing microtask drain before dispose.
        await Promise.resolve();
      } finally {
        subscription.dispose();
      }
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  /**
   * Shared capturing provider for the coalescing regression tests below:
   * exposes its tools listeners so each test can fire the synchronous
   * docChanged-coupled bump, a selection-driven bump, or an async
   * diagnostics completion on demand.
   */
  function capturingLatexProvider(
    toolListeners: Set<() => void>,
  ): DocumentEditorProvider {
    return {
      id: 'test-latex-coalescing-regression',
      kindIds: [latexKindId],
      createEditor() {
        return {
          focus() {
            // No-op test double.
          },
          hasFocus() {
            return false;
          },
          execCommand() {
            return false;
          },
          setReadOnly() {
            // No-op test double.
          },
          flush() {
            // No-op test double.
          },
          destroy() {
            // No-op test double.
          },
          tools: {
            snapshot: () =>
              ({ context: 'LaTeX', controls: [] }) as never,
            execute: () => false,
            onDidChange: (listener: () => void) => {
              toolListeners.add(listener);
              return {
                dispose: () => {
                  toolListeners.delete(listener);
                },
              };
            },
          },
        } as unknown as ReturnType<DocumentEditorProvider['createEditor']>;
      },
    };
  }

  function fireTools(toolListeners: ReadonlySet<() => void>): void {
    for (const listener of [...toolListeners]) listener();
  }

  it('notifies per session: two same-sequence commits in one tick bump twice', async () => {
    // per-session edit generations each start at 0, so two live
    // sessions commit sequence 1 in the same tick. The old global
    // sequence key suppressed the second session's commit; per-session
    // keys notify once each.
    const toolListeners = new Set<() => void>();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [latexKind],
      documentEditorProviders: [capturingLatexProvider(toolListeners)],
    });
    const controller = createWorkbenchController(app);
    try {
      const workspace = app.getWorkspace()!;
      const first = await workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('a.tex'),
        initialModel: latexModel('\\section{A}\n'),
      });
      const second = await workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('b.tex'),
        initialModel: latexModel('\\section{B}\n'),
      });
      await controller.openDocument(String(first.documentId), {});
      const otherPane = controller.splitPane('main', 'right');
      await controller.openDocument(String(second.documentId), {}, {
        pane: otherPane,
      });
      const sessionA = workspace.getOpenDocument(first.documentId)!;
      const sessionB = workspace.getOpenDocument(second.documentId)!;
      expect(sessionA.contentSequence).toBe(0);
      expect(sessionB.contentSequence).toBe(0);

      let notifications = 0;
      const subscription = controller.onDidChange(() => {
        notifications += 1;
      });
      try {
        (sessionA.model as unknown as { raw: string }).raw += '\n% a\n';
        sessionA.markDirty();
        (sessionB.model as unknown as { raw: string }).raw += '\n% b\n';
        sessionB.markDirty();
        expect(notifications).toBe(2);
        // Let the coalescing microtask drain before dispose.
        await Promise.resolve();
      } finally {
        subscription.dispose();
      }
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('still notifies a selection-driven tools change after the triple skip', async () => {
    // only the docChanged-coupled tools bump (the content
    // triple's redundant second bump) is coalesced. A later tools bump
    // for the same sequence in the same tick — the markdown
    // `selectionSet`-only path — is a genuine snapshot change and still
    // notifies.
    const toolListeners = new Set<() => void>();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [latexKind],
      documentEditorProviders: [capturingLatexProvider(toolListeners)],
    });
    const controller = createWorkbenchController(app);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('paper.tex'),
        initialModel: latexModel('\\section{Intro}\n'),
      });
      await controller.openDocument(String(ref.documentId), {});
      const session = workspace.getOpenDocument(ref.documentId)!;

      let notifications = 0;
      const subscription = controller.onDidChange(() => {
        notifications += 1;
      });
      try {
        (session.model as unknown as { raw: string }).raw += '\n% typing\n';
        session.markDirty();
        // The docChanged-coupled redundant bump: skipped (triple -> 1).
        fireTools(toolListeners);
        expect(notifications).toBe(1);
        // A selection-driven tools change for the same sequence in the
        // same tick still notifies.
        fireTools(toolListeners);
        expect(notifications).toBe(2);
        // Let the coalescing microtask drain before dispose.
        await Promise.resolve();
      } finally {
        subscription.dispose();
      }
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('notifies async diagnostics tools completion after the microtask drains', async () => {
    // the LaTeX single-notify path suppresses the synchronous
    // tools bump and notifies diagnostics completion asynchronously. Once
    // the coalescing microtask drains, that tools bump must notify.
    const toolListeners = new Set<() => void>();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [latexKind],
      documentEditorProviders: [capturingLatexProvider(toolListeners)],
    });
    const controller = createWorkbenchController(app);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('paper.tex'),
        initialModel: latexModel('\\section{Intro}\n'),
      });
      await controller.openDocument(String(ref.documentId), {});
      const session = workspace.getOpenDocument(ref.documentId)!;

      let notifications = 0;
      const subscription = controller.onDidChange(() => {
        notifications += 1;
      });
      try {
        (session.model as unknown as { raw: string }).raw += '\n% typing\n';
        session.markDirty();
        fireTools(toolListeners);
        expect(notifications).toBe(1);
        // Drain the coalescing microtask, then complete diagnostics.
        await Promise.resolve();
        await Promise.resolve();
        fireTools(toolListeners);
        expect(notifications).toBe(2);
      } finally {
        subscription.dispose();
      }
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });

  it('always notifies legacy null-sequence bumps through the notify path', async () => {
    // a session double without a numeric `contentSequence`
    // (hash-fallback shape) never coalesces — dirty, content,
    // and tools bumps each notify end to end.
    const toolListeners = new Set<() => void>();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [latexKind],
      documentEditorProviders: [capturingLatexProvider(toolListeners)],
    });
    const controller = createWorkbenchController(app);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('paper.tex'),
        initialModel: latexModel('\\section{Intro}\n'),
      });
      await controller.openDocument(String(ref.documentId), {});
      const session = workspace.getOpenDocument(ref.documentId)!;
      const sequenceSpy = vi
        .spyOn(session, 'contentSequence', 'get')
        .mockReturnValue(NaN);

      let notifications = 0;
      const subscription = controller.onDidChange(() => {
        notifications += 1;
      });
      try {
        (session.model as unknown as { raw: string }).raw += '\n% typing\n';
        session.markDirty();
        // Dirty + content: neither skipped without a numeric sequence.
        expect(notifications).toBe(2);
        fireTools(toolListeners);
        expect(notifications).toBe(3);
        // Let the coalescing microtask drain before dispose.
        await Promise.resolve();
      } finally {
        subscription.dispose();
        sequenceSpy.mockRestore();
      }
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });
});
