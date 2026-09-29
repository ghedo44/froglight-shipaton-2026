import { describe, expect, it, vi } from 'vitest';
import {
  appendPage,
  blockPageKind,
  blockPageKindId,
  boundedFrame,
  documentKindId,
  emptyBlockPage,
  emptyNotebook,
  emptySurface,
  inkPageKind,
  inkPageKindId,
  markdownKind,
  markdownKindId,
  memoryVaultPlugin,
  notebookKind,
  notebookKindId,
  notebookPage,
  pdfKind,
  pdfKindId,
  textObject,
  workspacePath,
  type CompositionHandle,
  type CompositionSnapshot,
  type SurfaceModel,
} from '@froglight/foundation';
import { MockPdfProvider } from '@froglight/foundation/testing';
import { createFirstPartyCompositionProviders } from './composition-providers.js';
import {
  compositionSnapshotsEqual,
  createCompositionRefreshCounters,
} from './composition-providers.js';
import { createApp } from './index.js';

async function settled(
  handle: CompositionHandle,
): Promise<CompositionSnapshot> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const snapshot = handle.snapshot();
    if (snapshot.state !== 'loading') return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return handle.snapshot();
}

describe('application — first-party composition providers', () => {
  it('renders standalone PDF previews and addressed transclusions as provider-neutral images', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [pdfKind],
      pdfProvider: new MockPdfProvider({
        pages: [
          {
            geometry: { mediaBox: [0, 0, 612, 792] },
            text: [{ text: 'Cover' }],
            links: [],
          },
          {
            geometry: { mediaBox: [0, 0, 612, 792] },
            text: [{ text: 'Second page' }],
            links: [],
          },
        ],
      }),
      pdfPreviewRenderer: (_bytes, pageIndex) => ({
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,page-${pageIndex}`,
        alt: `Rendered PDF page ${pageIndex + 1}`,
        width: 612,
        height: 792,
      }),
    });
    const workspace = app.getWorkspace()!;
    const pdf = await workspace.createDocument({
      kindId: pdfKindId,
      path: workspacePath('paper.pdf'),
      initialModel: { bytes: new Uint8Array([37, 80, 68, 70]) },
    });
    const target = {
      documentId: pdf.documentId,
      kindId: pdf.kindId,
      resourceId: pdf.location.resourceId,
    };

    const preview = app
      .getCompositionRegistry()
      .open({ role: 'preview', target });
    expect(await settled(preview)).toMatchObject({
      state: 'ready',
      summary: 'Cover',
      image: { dataUrl: 'data:image/png;base64,page-0' },
    });
    const transclusion = app.getCompositionRegistry().open({
      role: 'transclusion',
      target: { ...target, address: '1' },
    });
    expect(await settled(transclusion)).toMatchObject({
      state: 'ready',
      title: 'PDF page 2',
      summary: 'Second page',
      image: { dataUrl: 'data:image/png;base64,page-1' },
    });

    preview.dispose();
    transclusion.dispose();
    await app.dispose();
  });

  it('previews every current canonical resource family without editor-provider types', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [markdownKind, blockPageKind, inkPageKind, notebookKind],
      inkPreviewRenderer: () => ({
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        alt: 'Rendered Ink preview',
        width: 400,
        height: 300,
      }),
    });
    const workspace = app.getWorkspace()!;
    const markdown = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('note.md'),
      initialModel: { raw: '# Markdown preview' },
    });
    const block = await workspace.createDocument({
      kindId: blockPageKindId,
      path: workspacePath('page.blockpage'),
      initialModel: emptyBlockPage({ title: 'Block preview' }),
    });
    const inkModel = emptySurface(boundedFrame(400, 300));
    inkModel.objects.label = textObject('label', {
      x: 0,
      y: 0,
      text: 'Ink preview',
    });
    inkModel.order.push('label');
    const ink = await workspace.createDocument({
      kindId: inkPageKindId,
      path: workspacePath('drawing.ink'),
      initialModel: inkModel,
    });
    const notebookModel = emptyNotebook('Notebook preview');
    appendPage(notebookModel, notebookPage('p1'));
    const notebook = await workspace.createDocument({
      kindId: notebookKindId,
      path: workspacePath('book.notebook'),
      initialModel: notebookModel,
    });

    for (const [ref, expected] of [
      [markdown, 'Markdown preview'],
      [block, 'Block preview'],
      [ink, 'Ink preview'],
      [notebook, 'Notebook preview'],
    ] as const) {
      const handle = app
        .getCompositionRegistry()
        .open({
          role: 'preview',
          target: {
            documentId: ref.documentId,
            kindId: ref.kindId,
            resourceId: ref.location.resourceId,
          },
        });
      expect(await settled(handle)).toMatchObject({
        state: 'ready',
        [ref.kindId === inkPageKindId ? 'summary' : 'title']: expected,
      });
      if (ref.kindId === inkPageKindId) {
        expect(handle.snapshot()).toMatchObject({
          image: {
            mimeType: 'image/png',
            alt: 'Rendered Ink preview',
            width: 400,
            height: 300,
          },
        });
      }
      handle.dispose();
    }
    await app.dispose();
  });

  it('refreshes an open preview after the authoritative source commits', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [inkPageKind],
      inkPreviewRenderer: (model) => ({
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${model.order.length === 0 ? 'MA==' : 'MQ=='}`,
        alt: 'Live Ink preview',
        width: 400,
        height: 300,
      }),
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: inkPageKindId,
      path: workspacePath('live.ink'),
      initialModel: emptySurface(boundedFrame(400, 300)),
    });
    const handle = app.getCompositionRegistry().open({
      role: 'preview',
      target: {
        documentId: ref.documentId,
        kindId: ref.kindId,
        resourceId: ref.location.resourceId,
      },
    });
    expect(await settled(handle)).toMatchObject({
      image: { dataUrl: 'data:image/png;base64,MA==' },
    });

    const session = await workspace.openDocument<SurfaceModel>(ref.documentId);
    session.model.objects.label = textObject('label', {
      x: 0,
      y: 0,
      text: 'Changed',
    });
    session.model.order.push('label');
    session.markDirty();
    await session.save();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = handle.snapshot();
      if (
        current.state === 'ready' &&
        current.image?.dataUrl === 'data:image/png;base64,MQ=='
      )
        break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(handle.snapshot()).toMatchObject({
      image: { dataUrl: 'data:image/png;base64,MQ==' },
      summary: 'Changed',
    });
    handle.dispose();
    await app.dispose();
  });

  it('runs a source-authoritative linked view through a deterministic mock provider', async () => {    const invoke = vi.fn();
    const kindId = documentKindId('acme.collection');
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      compositionProviders: [
        {
          kindId,
          roles: ['linked-view'],
          writeAuthority: 'source',
          open: () => ({
            snapshot: () => ({
              state: 'ready',
              title: 'Assigned',
              items: [{ id: 'one', text: 'First task' }],
              actions: [{ id: 'add', label: 'Add task', authority: 'source' }],
            }),
            onDidChange: () => ({
              dispose() {
                /* deterministic static mock */
              },
            }),
            invoke,
            dispose() {
              /* deterministic static mock */
            },
          }),
        },
      ],
    });
    const handle = app
      .getCompositionRegistry()
      .open({
        role: 'linked-view',
        viewId: 'assigned',
        target: {
          documentId: 'collection-1',
          kindId,
          resourceId: 'collection-1',
        },
      });
    expect(handle.snapshot()).toMatchObject({
      state: 'ready',
      title: 'Assigned',
      items: [{ text: 'First task' }],
    });
    await handle.invoke?.('add', { title: 'Second task' });
    expect(invoke).toHaveBeenCalledWith('add', { title: 'Second task' });
    await app.dispose();
  });
});

describe('application — composition snapshot equality', () => {
  it('treats identical plain-data snapshots as equal', () => {
    expect(
      compositionSnapshotsEqual({ state: 'loading' }, { state: 'loading' }),
    ).toBe(true);
    expect(
      compositionSnapshotsEqual(
        {
          state: 'ready',
          title: 'Hi',
          summary: 'body',
          image: {
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,MA==',
            alt: 'preview',
            width: 400,
            height: 300,
          },
          items: [{ id: 'one', text: 'First' }],
          actions: [{ id: 'open-source', label: 'Open source', authority: 'none' }],
        },
        {
          state: 'ready',
          title: 'Hi',
          summary: 'body',
          image: {
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,MA==',
            alt: 'preview',
            width: 400,
            height: 300,
          },
          items: [{ id: 'one', text: 'First' }],
          actions: [{ id: 'open-source', label: 'Open source', authority: 'none' }],
        },
      ),
    ).toBe(true);
  });

  it('detects changed content, states, and placeholder reasons', () => {
    expect(
      compositionSnapshotsEqual({ state: 'loading' }, { state: 'ready' }),
    ).toBe(false);
    expect(
      compositionSnapshotsEqual(
        { state: 'ready', summary: 'one' },
        { state: 'ready', summary: 'two' },
      ),
    ).toBe(false);
    expect(
      compositionSnapshotsEqual(
        {
          state: 'placeholder',
          reason: 'missing-target',
          message: 'gone',
          recoverable: true,
        },
        {
          state: 'placeholder',
          reason: 'missing-target',
          message: 'gone',
          recoverable: true,
        },
      ),
    ).toBe(true);
    expect(
      compositionSnapshotsEqual(
        {
          state: 'placeholder',
          reason: 'missing-target',
          message: 'gone',
          recoverable: true,
        },
        {
          state: 'placeholder',
          reason: 'unsupported-address',
          message: 'gone',
          recoverable: true,
        },
      ),
    ).toBe(false);
  });
});

describe('application — incremental composition refresh', () => {
  function stubRefreshDeps(raw: { current: string }) {
    const counters = createCompositionRefreshCounters();
    const ref = {
      documentId: 'doc-1',
      kindId: String(markdownKindId),
      location: { resourceId: 'res-1' },
    };
    let commit: ((documentId: unknown) => void) | null = null;
    const workspace = {
      readDocument: async () => ({ ref, model: { raw: raw.current } }),
      onDidCommit: (listener: (documentId: unknown) => void) => {
        commit = listener;
        return {
          dispose: () => {
            commit = null;
          },
        };
      },
    };
    return {
      counters,
      emitCommit: () => commit?.('doc-1'),
      deps: {
        workspace: () => workspace as never,
        openSource: () => undefined,
        refreshCounters: counters,
      },
    };
  }

  function markdownPreviewOf(
    providers: ReturnType<typeof createFirstPartyCompositionProviders>,
  ): CompositionHandle {
    const provider = providers.find(
      (entry) => String(entry.kindId) === String(markdownKindId),
    )!;
    return provider.open({
      role: 'preview',
      target: {
        documentId: 'doc-1',
        kindId: String(markdownKindId),
        resourceId: 'res-1',
      },
      ancestry: [],
    });
  }

  async function flushed(handle: CompositionHandle): Promise<CompositionSnapshot> {
    // The stub workspace resolves with zero I/O delay, so a commit-triggered
    // refresh is still in flight when emit returns; drain macrotasks until
    // the publish microtask chain has landed.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return handle.snapshot();
  }

  it('skips listener notification when a commit reloads identical content', async () => {
    const raw = { current: '# Hi\n' };
    const { deps, emitCommit, counters } = stubRefreshDeps(raw);
    const handle = markdownPreviewOf(createFirstPartyCompositionProviders(deps));
    expect(await settled(handle)).toMatchObject({
      state: 'ready',
      title: 'Hi',
    });
    const before = handle.snapshot();
    let notifications = 0;
    const subscription = handle.onDidChange(() => {
      notifications += 1;
    });
    const loadsBefore = counters.loads;
    emitCommit();
    expect(await flushed(handle)).toMatchObject({ title: 'Hi' });
    expect(notifications).toBe(0);
    expect(counters.loads).toBeGreaterThan(loadsBefore);
    expect(counters.skipped).toBe(1);
    // The previous reference survives so downstream memoization holds.
    expect(handle.snapshot()).toBe(before);
    subscription.dispose();
    handle.dispose();
  });

  it('notifies exactly once when a commit changes content', async () => {
    const raw = { current: '# Hi\n' };
    const { deps, emitCommit, counters } = stubRefreshDeps(raw);
    const handle = markdownPreviewOf(createFirstPartyCompositionProviders(deps));
    expect(await settled(handle)).toMatchObject({ title: 'Hi' });
    const before = handle.snapshot();
    let notifications = 0;
    const subscription = handle.onDidChange(() => {
      notifications += 1;
    });
    raw.current = '# Changed\n';
    emitCommit();
    expect(await flushed(handle)).toMatchObject({ title: 'Changed' });
    expect(notifications).toBe(1);
    expect(counters.notified).toBeGreaterThanOrEqual(1);
    expect(handle.snapshot()).not.toBe(before);
    subscription.dispose();
    handle.dispose();
  });

  it('stays silent through a real unchanged save and live on a changed one', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [markdownKind],
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('live.md'),
      initialModel: { raw: '# Live\n' },
    });
    const handle = app.getCompositionRegistry().open({
      role: 'preview',
      target: {
        documentId: ref.documentId,
        kindId: ref.kindId,
        resourceId: ref.location.resourceId,
      },
    });
    expect(await settled(handle)).toMatchObject({ title: 'Live' });
    let notifications = 0;
    const subscription = handle.onDidChange(() => {
      notifications += 1;
    });
    const session = (await workspace.openDocument(ref.documentId)) as unknown as {
      model: { raw: string };
      markDirty(): void;
      save(): Promise<unknown>;
    };
    session.markDirty();
    await session.save();
    // Let any scheduled refresh settle, then assert silence.
    await settled(handle);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(handle.snapshot()).toMatchObject({ title: 'Live' });
    expect(notifications).toBe(0);
    session.model.raw = '# Live now\n';
    session.markDirty();
    await session.save();
    expect(await settled(handle)).toMatchObject({ title: 'Live now' });
    expect(notifications).toBe(1);
    subscription.dispose();
    handle.dispose();
    await app.dispose();
  });
});
