// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  documentId,
  pdfKindId,
  resourceId,
  type PdfOutlineEntry,
  type PdfProvider,
} from '@froglight/foundation';
import {
  PdfDocumentEditorProvider,
  type PdfReaderHandle,
} from '../editor.js';
import {
  PdfReaderSkeleton,
  type PdfSkeleton,
} from './PdfReaderSkeleton.jsx';
import pdfReaderCss from './PdfReaderSkeleton.css?inline';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeFakeProvider(
  pageCount = 3,
  outline: readonly PdfOutlineEntry[] = [],
): {
  provider: PdfProvider;
  mounts: Array<{ pageIndex: number; parent: unknown; scale: number }>;
  opened: Uint8Array[];
  closedCount: () => number;
  outlineReads: () => number;
} {
  const mounts: Array<{ pageIndex: number; parent: unknown; scale: number }> =
    [];
  const opened: Uint8Array[] = [];
  let closed = 0;
  let outlineReadCount = 0;
  const provider: PdfProvider = {
    async open(input) {
      opened.push(input.bytes);
      return {
        pageCount,
        getPageInfo: async (pageIndex) => ({
          pageIndex,
          geometry: {
            effectiveBox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
            userUnit: 1,
            rotate: 0 as const,
            pageBox: { widthPt: 100, heightPt: 100 },
          },
        }),
        getPageText: async (pageIndex) => ({
          kind: 'source' as const,
          items: [{ text: `page ${pageIndex} hello` }],
        }),
        getOutline: async () => {
          outlineReadCount += 1;
          return outline;
        },
        getLinks: async () => [],
        mountPage: async (request) => {
          const parent = request.parent as HTMLElement;
          const marker = parent.ownerDocument.createElement('div');
          marker.className = 'fl-pdf-page';
          marker.dataset.pageIndex = String(request.pageIndex);
          parent.appendChild(marker);
          mounts.push({
            pageIndex: request.pageIndex,
            parent: request.parent,
            scale: request.scale,
          });
          return {
            destroy: () => {
              marker.remove();
            },
          };
        },
        close: async () => {
          closed += 1;
        },
      };
    },
  };
  return {
    provider,
    mounts,
    opened,
    closedCount: () => closed,
    outlineReads: () => outlineReadCount,
  };
}

function makeSession(bytes: Uint8Array): Record<string, unknown> {
  return {
    model: { bytes },
    ref: {
      documentId: documentId('pdf-doc'),
      kindId: pdfKindId,
      location: { resourceId: resourceId('pdf-resource') },
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  root = null;
  host = null;
});

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
  }
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('pdf reader skeleton (React chrome)', () => {
  it('commits the identical skeleton structure with refs populated', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const skeletonRef: { current: PdfSkeleton | null } = { current: null };
    await act(async () => {
      root!.render(createElement(PdfReaderSkeleton, { skeletonRef }));
    });
    const skeleton = skeletonRef.current;
    expect(skeleton).not.toBeNull();
    expect(skeleton!.root.className).toBe('fl-pdf-reader');
    expect(skeleton!.root.tabIndex).toBe(0);
    // Layout ships with the colocated skeleton stylesheet under the
    // components layer — never as inline styles or injected sheets.
    expect(pdfReaderCss).toContain('.fl-pdf-reader');
    expect(pdfReaderCss).toContain('width: 100%');
    expect(pdfReaderCss).toContain('display: grid');
    expect(pdfReaderCss).toContain('@layer components');
    expect(host.contains(skeleton!.root)).toBe(true);
  });

  it('provider creation synchronously commits chrome the engine consumes', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { provider } = makeFakeProvider(3);
    const editorProvider = new PdfDocumentEditorProvider({
      pdfProvider: provider,
    });
    let handle: PdfReaderHandle | undefined;
    await act(async () => {
      handle = editorProvider.createEditor({
        session: makeSession(new Uint8Array([1, 2, 3])) as never,
        parent,
      });
    });
    // No extra flush: the reader chrome exists immediately, preserving the
    // synchronous createEditor contract while page mounting stays async.
    const chrome = parent.querySelector('.fl-pdf-reader');
    expect(chrome).not.toBeNull();
    expect(handle!.tools).toBeDefined();
    expect(handle!.canExecCommand?.('undo')).toBe(false);
    expect(handle!.execCommand('undo')).toBe(false);
    handle!.destroy();
    expect(parent.querySelector('.fl-pdf-reader')).toBeNull();
    expect(parent.childElementCount).toBe(0);
    parent.remove();
  });

  it('engine mounts pages into the React-committed root with identical geometry', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const fake = makeFakeProvider(3);
    const editorProvider = new PdfDocumentEditorProvider({
      pdfProvider: fake.provider,
    });
    let handle: PdfReaderHandle | undefined;
    await act(async () => {
      handle = editorProvider.createEditor({
        session: makeSession(new Uint8Array([7, 8, 9])) as never,
        parent,
      });
    });
    const chrome = parent.querySelector('.fl-pdf-reader');
    expect(chrome).not.toBeNull();
    await act(async () => {
      await flush();
    });
    expect(fake.mounts.length).toBeGreaterThan(0);
    // The mount parent is the React-owned skeleton root itself.
    expect(fake.mounts[0]!.parent).toBe(chrome);
    // jsdom has no layout (clientWidth 0), so the provider falls back to
    // the page-box width and mounts at scale 1 — identical to before.
    expect(fake.mounts[0]!.scale).toBe(1);
    expect(
      chrome!.querySelector('.fl-pdf-page[data-page-index="0"]'),
    ).not.toBeNull();
    // Unmount the React owner before engine teardown: same order the
    // provider uses, so no React-managed node is yanked mid-teardown.
    handle!.destroy();
    expect(parent.querySelector('.fl-pdf-reader')).toBeNull();
    expect(parent.querySelector('.fl-pdf-page')).toBeNull();
    parent.remove();
  });

  it('reveal navigates pages and import-as-notebook exports a bytes copy', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const fake = makeFakeProvider(3);
    const source = new Uint8Array([10, 20, 30]);
    let exported: Uint8Array | null = null;
    const editorProvider = new PdfDocumentEditorProvider({
      pdfProvider: fake.provider,
      importAsNotebook: (bytes) => {
        exported = bytes;
      },
    });
    let handle: PdfReaderHandle | undefined;
    await act(async () => {
      handle = editorProvider.createEditor({
        session: makeSession(source) as never,
        parent,
      });
    });
    await act(async () => {
      await flush();
    });
    handle!.revealAddress?.('2');
    await act(async () => {
      await flush();
    });
    const lastMount = fake.mounts[fake.mounts.length - 1]!;
    expect(lastMount.pageIndex).toBe(2);
    const snapshot = handle!.tools!.snapshot();
    expect(
      snapshot.controls.find((control) => control.id === 'pdf.outline'),
    ).toBeUndefined();
    expect(fake.outlineReads()).toBe(1);
    const status = snapshot.controls.find(
      (control) => control.id === 'pdf.page',
    );
    expect(status).toMatchObject({ label: '3 / 3' });
    // Invalid addresses are ignored.
    handle!.revealAddress?.('nope');
    await act(async () => {
      await flush();
    });
    expect(fake.mounts[fake.mounts.length - 1]!.pageIndex).toBe(2);
    expect(handle!.tools!.execute('pdf.import-notebook')).toBe(true);
    expect(exported).not.toBeNull();
    expect(Array.from(exported!)).toEqual([10, 20, 30]);
    expect(exported!).not.toBe(source);
    expect(Array.from(source)).toEqual([10, 20, 30]);
    handle!.destroy();
    parent.remove();
  });

  it('exposes source outline destinations and navigates without reopening', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const fake = makeFakeProvider(3, [
      {
        id: 'chapter',
        title: 'Chapter',
        pageIndex: 1,
        children: [
          {
            id: 'section',
            title: 'Section',
            pageIndex: 2,
            children: [],
          },
        ],
      },
    ]);
    const editorProvider = new PdfDocumentEditorProvider({
      pdfProvider: fake.provider,
    });
    const handle = editorProvider.createEditor({
      session: makeSession(new Uint8Array([7, 7, 7])) as never,
      parent,
    });
    const tools = handle.tools;
    if (tools === undefined) throw new Error('PDF tools did not mount');
    expect(
      tools.snapshot().controls.find(({ id }) => id === 'pdf.outline'),
    ).toBeUndefined();
    await act(flush);

    const outline = tools.snapshot().controls.find(
      ({ id }) => id === 'pdf.outline',
    );
    expect(outline).toMatchObject({
      kind: 'choice',
      label: 'PDF outline',
      value: '',
      options: [
        { value: '', label: 'PDF outline…' },
        { value: '0:1', label: 'Chapter' },
        { value: '1:2', label: '  Section' },
      ],
    });
    expect(fake.opened).toHaveLength(1);
    expect(fake.outlineReads()).toBe(1);

    expect(tools.execute('pdf.outline', '1:2')).toBe(true);
    await act(flush);
    expect(fake.mounts.at(-1)).toMatchObject({ pageIndex: 2 });
    expect(fake.opened).toHaveLength(1);
    expect(fake.outlineReads()).toBe(1);
    expect(
      tools.snapshot().controls.find(({ id }) => id === 'pdf.outline'),
    ).toMatchObject({ value: '' });
    act(() => handle.destroy());
    parent.remove();
  });

  it('keeps the rendered PDF usable when its outline is unavailable', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const fake = makeFakeProvider(3);
    const provider: PdfProvider = {
      async open(input) {
        const document = await fake.provider.open(input);
        return {
          ...document,
          getOutline: async () => {
            throw new Error('outline parse failed');
          },
        };
      },
    };
    const handle = new PdfDocumentEditorProvider({
      pdfProvider: provider,
    }).createEditor({
      session: makeSession(new Uint8Array([6, 6, 6])) as never,
      parent,
    });
    const tools = handle.tools;
    if (tools === undefined) throw new Error('PDF tools did not mount');
    await act(flush);

    expect(parent.querySelector('.fl-pdf-page')).not.toBeNull();
    expect(tools.snapshot().controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'pdf.page', label: '1 / 3' }),
        expect.objectContaining({
          id: 'pdf.outline',
          kind: 'status',
          label: 'PDF outline unavailable',
        }),
      ]),
    );
    expect(tools.execute('pdf.next')).toBe(true);
    await act(flush);
    expect(fake.mounts.at(-1)).toMatchObject({ pageIndex: 1 });
    expect(fake.opened).toHaveLength(1);
    expect(fake.closedCount()).toBe(0);
    act(() => handle.destroy());
    parent.remove();
  });

  it('ignores a cancelled outline result after reader teardown', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const fake = makeFakeProvider(1);
    let markOutlineStarted: (() => void) | undefined;
    const outlineStarted = new Promise<void>((resolve) => {
      markOutlineStarted = resolve;
    });
    const provider: PdfProvider = {
      async open(input) {
        const document = await fake.provider.open(input);
        return {
          ...document,
          getOutline: async (signal) => {
            markOutlineStarted?.();
            return new Promise<readonly PdfOutlineEntry[]>(
              (_resolve, reject) => {
                signal?.addEventListener(
                  'abort',
                  () => reject(new DOMException('aborted', 'AbortError')),
                  { once: true },
                );
              },
            );
          },
        };
      },
    };
    const handle = new PdfDocumentEditorProvider({
      pdfProvider: provider,
    }).createEditor({
      session: makeSession(new Uint8Array([5, 5, 5])) as never,
      parent,
    });
    const tools = handle.tools;
    if (tools === undefined) throw new Error('PDF tools did not mount');
    await act(async () => outlineStarted);
    expect(parent.querySelector('.fl-pdf-page')).not.toBeNull();
    act(() => handle.destroy());
    await act(flush);

    expect(
      tools.snapshot().controls.find(({ id }) => id === 'pdf.outline'),
    ).toBeUndefined();
    expect(fake.opened).toHaveLength(1);
    parent.remove();
  });

  it('retains the current page when the workbench reattaches the same session', async () => {
    const firstParent = document.createElement('div');
    const secondParent = document.createElement('div');
    document.body.append(firstParent, secondParent);
    const fake = makeFakeProvider(3);
    let promptCount = 0;
    const lockedProvider: PdfProvider = {
      async open(input) {
        if (input.password !== 'correct') {
          throw Object.assign(new Error('required'), {
            code: 'PDF_PASSWORD_REQUIRED',
          });
        }
        return fake.provider.open(input);
      },
    };
    const editorProvider = new PdfDocumentEditorProvider({
      pdfProvider: lockedProvider,
      promptForPassword: async () => {
        promptCount += 1;
        return 'correct';
      },
    });
    const session = makeSession(new Uint8Array([1, 2, 3])) as never;
    const first = editorProvider.createEditor({ session, parent: firstParent });
    await act(flush);
    expect(promptCount).toBe(1);

    first.revealAddress?.('2');
    await act(flush);
    expect(first.tools!.snapshot().controls).toContainEqual(
      expect.objectContaining({ id: 'pdf.page', label: '3 / 3' }),
    );
    act(() => first.destroy());

    const reattached = editorProvider.createEditor({
      session,
      parent: secondParent,
    });
    await act(flush);

    expect(fake.mounts[fake.mounts.length - 1]!.pageIndex).toBe(2);
    expect(promptCount).toBe(1);
    expect(reattached.tools!.snapshot().controls).toContainEqual(
      expect.objectContaining({ id: 'pdf.page', label: '3 / 3' }),
    );
    act(() => reattached.destroy());
    firstParent.remove();
    secondParent.remove();
  });

  it('refits the current page when the reader width changes', async () => {
    class ControlledResizeObserver {
      static readonly instances: ControlledResizeObserver[] = [];
      disconnected = false;

      constructor(readonly callback: ResizeObserverCallback) {
        ControlledResizeObserver.instances.push(this);
      }

      observe(): void {
        // The test invokes resize delivery explicitly through notify().
      }
      unobserve(): void {
        // The production handle only needs disconnect() during teardown.
      }
      disconnect(): void {
        this.disconnected = true;
      }

      notify(): void {
        this.callback([], this as unknown as ResizeObserver);
      }
    }
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const fake = makeFakeProvider(3);
    const editorProvider = new PdfDocumentEditorProvider({
      pdfProvider: fake.provider,
    });
    const handle = editorProvider.createEditor({
      session: makeSession(new Uint8Array([4, 5, 6])) as never,
      parent,
    });
    await act(flush);
    handle.revealAddress?.('2');
    await act(flush);

    const chrome = parent.querySelector<HTMLElement>('.fl-pdf-reader');
    expect(chrome).not.toBeNull();
    Object.defineProperty(chrome, 'clientWidth', { value: 240 });
    ControlledResizeObserver.instances[0]!.notify();
    await act(flush);

    expect(fake.mounts[fake.mounts.length - 1]).toMatchObject({
      pageIndex: 2,
      scale: 2.4,
    });
    expect(handle.tools!.snapshot().controls).toContainEqual(
      expect.objectContaining({ id: 'pdf.page', label: '3 / 3' }),
    );
    act(() => handle.destroy());
    expect(ControlledResizeObserver.instances[0]!.disconnected).toBe(true);
    parent.remove();
  });

  it('keeps the immutable source read-only and never marks dirty', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const fake = makeFakeProvider(2);
    const source = new Uint8Array([4, 5, 6]);
    const editorProvider = new PdfDocumentEditorProvider({
      pdfProvider: fake.provider,
    });
    let handle: PdfReaderHandle | undefined;
    await act(async () => {
      handle = editorProvider.createEditor({
        session: makeSession(source) as never,
        parent,
      });
    });
    await act(async () => {
      await flush();
    });
    // Read-only is structural: no-ops, no undo, but selection stays on.
    expect(() => handle!.setReadOnly?.(true)).not.toThrow();
    expect(() => handle!.setReadOnly?.(false)).not.toThrow();
    expect(handle!.canExecCommand?.('undo')).toBe(false);
    expect(handle!.canExecCommand?.('redo')).toBe(false);
    expect(handle!.execCommand('undo')).toBe(false);
    expect(handle!.execCommand('redo')).toBe(false);
    // The provider opened a copy; the canonical bytes are untouched, and
    // text search still resolves through the generic seam.
    expect(fake.opened.length).toBe(1);
    expect(fake.opened[0]!).not.toBe(source);
    expect(Array.from(fake.opened[0]!)).toEqual([4, 5, 6]);
    expect(Array.from(source)).toEqual([4, 5, 6]);
    expect(await handle!.searchSource('hello')).toHaveLength(2);
    expect(Array.from(source)).toEqual([4, 5, 6]);
    handle!.destroy();
    parent.remove();
  });

  it('shows an unlock action after password cancellation and recovers in place', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const fake = makeFakeProvider(1);
    const attempts: Array<string | undefined> = [];
    const answers: Array<string | null> = [null, 'correct'];
    const locked: PdfProvider = {
      async open(input) {
        attempts.push(input.password);
        if (input.password !== 'correct') {
          throw Object.assign(new Error('required'), {
            code: 'PDF_PASSWORD_REQUIRED',
          });
        }
        return fake.provider.open(input);
      },
    };
    const editorProvider = new PdfDocumentEditorProvider({
      pdfProvider: locked,
      promptForPassword: async () => answers.shift() ?? null,
      importAsNotebook: () => undefined,
    });
    let handle: PdfReaderHandle | undefined;
    await act(async () => {
      handle = editorProvider.createEditor({
        session: makeSession(new Uint8Array([3, 2, 1])) as never,
        parent,
      });
      await flush();
    });
    const reader = handle;
    if (reader === undefined) throw new Error('reader did not mount');

    expect(
      parent.querySelector('.fl-pdf-reader-placeholder p')?.textContent,
    ).toBe('PDF is locked.');
    const unlock = parent.querySelector<HTMLButtonElement>(
      '.fl-pdf-reader-retry',
    );
    expect(unlock?.textContent).toBe('Unlock PDF');
    const unavailable = reader.tools!.snapshot().controls;
    expect(
      unavailable.find((control) => control.id === 'pdf.page'),
    ).toMatchObject({ label: 'PDF locked' });
    for (const id of [
      'pdf.previous',
      'pdf.next',
      'pdf.source-select',
      'pdf.import-notebook',
    ]) {
      expect(unavailable.find((control) => control.id === id)).toMatchObject({
        disabled: true,
      });
    }

    await act(async () => {
      if (unlock === null) throw new Error('unlock action did not mount');
      unlock.click();
      await flush();
    });
    expect(attempts).toEqual([undefined, undefined, 'correct']);
    expect(parent.querySelector('.fl-pdf-reader-placeholder')).toBeNull();
    expect(parent.querySelector('.fl-pdf-page')).not.toBeNull();
    expect(
      reader.tools!.snapshot().controls.find(({ id }) => id === 'pdf.page'),
    ).toMatchObject({ label: '1 / 1' });
    expect(
      reader.tools!.snapshot().controls.find(({ id }) => id === 'pdf.retry'),
    ).toBeUndefined();
    reader.destroy();
    parent.remove();
  });

  it('keeps the no-DOM behavior identical without a headless twin', async () => {
    const fake = makeFakeProvider(2);
    const source = new Uint8Array([9, 9, 9]);
    const editorProvider = new PdfDocumentEditorProvider({
      pdfProvider: fake.provider,
    });
    const handle = editorProvider.createEditor({
      session: makeSession(source) as never,
      parent: {},
    });
    expect(handle.canExecCommand?.('undo')).toBe(false);
    expect(handle.execCommand('redo')).toBe(false);
    expect(await handle.searchSource('hello')).toHaveLength(2);
    expect(await handle.getOutline()).toEqual([]);
    expect(await handle.getLinks(0)).toEqual([]);
    expect(() => handle.setReadOnly?.(true)).not.toThrow();
    expect(() => handle.destroy()).not.toThrow();
  });
});
