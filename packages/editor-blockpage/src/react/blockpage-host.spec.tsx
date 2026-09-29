// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyBlockPage,
  paragraphBlock,
  type BlockPageEditorHandle,
  type BlockPageModel,
} from '@froglight/foundation';
import {
  BlockPageDocumentEditorProvider,
  BlockpageHostSkeleton,
  type BlockpageSkeleton,
} from '../index.js';
import { HeadlessBlockpageEditorHandle } from '../headless-handle.js';
import hostStyles from './BlockpageHost.module.css';
import hostCss from './BlockpageHost.module.css?inline';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function fixture(): BlockPageModel {
  const model = emptyBlockPage({ title: 'Fixture', tags: [], properties: {} });
  model.rootOrder = ['p1'];
  model.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
  return model;
}

function twoParas(): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['a', 'b'];
  model.blocks = {
    a: paragraphBlock('a', [{ text: 'alpha' }]),
    b: paragraphBlock('b', [{ text: 'beta' }]),
  };
  return model;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
  }
  root = null;
  host?.remove();
  host = null;
  document.body.replaceChildren();
});

describe('blockpage host skeleton (React chrome)', () => {
  it('commits the identical skeleton structure with refs populated', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const skeletonRef: { current: BlockpageSkeleton | null } = {
      current: null,
    };
    await act(async () => {
      root!.render(createElement(BlockpageHostSkeleton, { skeletonRef }));
    });
    const skeleton = skeletonRef.current;
    expect(skeleton).not.toBeNull();
    expect(
      skeleton!.host.classList.contains(hostStyles['froglight-blockpage']),
    ).toBe(true);
    expect(skeleton!.host.classList.contains('flbp-host')).toBe(true);
    expect(host.contains(skeleton!.host)).toBe(true);
    expect(host.firstElementChild).toBe(skeleton!.host);
  });

  it('provider creation synchronously commits chrome the engine consumes', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    let latest: BlockPageModel | null = null;
    const provider = new BlockPageDocumentEditorProvider();
    let handle: BlockPageEditorHandle | undefined;
    await act(async () => {
      handle = provider.createEditor({
        session: {} as never,
        parent,
        initialModel: fixture(),
        onDirtyModel: (next) => {
          latest = next;
        },
      });
    });
    // No extra flush: the ProseMirror surface the engine edits exists
    // immediately, preserving the synchronous createEditor contract.
    expect(parent.querySelector('.ProseMirror')).not.toBeNull();
    expect(
      parent.firstElementChild?.classList.contains(
        hostStyles['froglight-blockpage'],
      ),
    ).toBe(true);
    expect(parent.firstElementChild?.classList.contains('flbp-host')).toBe(
      true,
    );
    expect(parent.classList.contains('froglight-blockpage')).toBe(false);
    expect(handle!.tools).toBeDefined();
    expect(handle!.execCommand('undo')).toBe(false);
    expect(latest).toBeNull();
    // Engine chrome travels with the committed host.
    expect(parent.querySelector('.flbp-slash')).not.toBeNull();
    expect(parent.querySelector('.flbp-drag-handle')).not.toBeNull();
    expect(parent.querySelector('.flbp-list-drag-handle')).not.toBeNull();
    handle!.destroy();
    expect(parent.querySelector('.ProseMirror')).toBeNull();
    expect(parent.children).toHaveLength(0);
    parent.remove();
  });

  it('unmount empties the parent in provider destroy order', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    let handle: BlockPageEditorHandle | undefined;
    await act(async () => {
      handle = new BlockPageDocumentEditorProvider().createEditor({
        session: {} as never,
        parent,
        initialModel: fixture(),
        onDirtyModel: () => undefined,
      });
    });
    expect(parent.children).toHaveLength(1);
    handle!.destroy();
    expect(parent.children).toHaveLength(0);
    expect(parent.className).toBe('');
    parent.remove();
  });

  it('transactions, dirty-model sync, flush, and save/reopen stay identical', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    let latest: BlockPageModel | null = null;
    let handle: BlockPageEditorHandle | undefined;
    await act(async () => {
      handle = new BlockPageDocumentEditorProvider().createEditor({
        session: {} as never,
        parent,
        initialModel: twoParas(),
        onDirtyModel: (next) => {
          latest = next;
        },
      });
    });
    try {
      const live = handle as unknown as {
        blockCommand(id: string, arg?: unknown): boolean;
        getModelForTest(): BlockPageModel;
        flush(): void;
      };
      // Transaction through the real typing pipeline folds into canonical.
      live.blockCommand('set-selection', { from: 8, to: 8 + 'beta'.length });
      expect(live.blockCommand('insert-text', { text: 'rewritten' })).toBe(
        true,
      );
      expect(latest).not.toBeNull();
      expect(latest!.blocks.b).toMatchObject({
        runs: [{ text: 'rewritten' }],
      });
      // Flush forces any queued DOM observer work into state before save.
      live.flush();
      const afterFlush = live.getModelForTest();
      expect(afterFlush.blocks.b).toEqual(latest!.blocks.b);
      // Save/reopen: the dirty model reopens byte-faithful.
      const reopenParent = document.createElement('div');
      document.body.appendChild(reopenParent);
      let reopened: BlockPageEditorHandle | undefined;
      await act(async () => {
        reopened = new BlockPageDocumentEditorProvider().createEditor({
          session: {} as never,
          parent: reopenParent,
          initialModel: latest!,
          onDirtyModel: () => undefined,
        });
      });
      try {
        const reopenedLive = reopened as unknown as {
          getModelForTest(): BlockPageModel;
        };
        expect(reopenedLive.getModelForTest().blocks.b).toEqual(
          latest!.blocks.b,
        );
        expect(
          reopenParent.querySelector('.ProseMirror')?.textContent,
        ).toContain('rewritten');
      } finally {
        reopened!.destroy();
        reopenParent.remove();
      }
    } finally {
      handle!.destroy();
      parent.remove();
    }
  });

  it('slash and drag chrome keep working on the committed host', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    let handle: BlockPageEditorHandle | undefined;
    await act(async () => {
      handle = new BlockPageDocumentEditorProvider().createEditor({
        session: {} as never,
        parent,
        initialModel: fixture(),
        onDirtyModel: () => undefined,
      });
    });
    try {
      const live = handle as unknown as {
        blockCommand(id: string, arg?: unknown): boolean;
      };
      live.blockCommand('set-selection', { from: 1 });
      expect(live.blockCommand('insert-text', { text: '/' })).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 4));
      const menu = parent.querySelector('.flbp-slash');
      expect(menu).not.toBeNull();
      expect(menu!.getAttribute('style')).toContain('block');
      // Drag chrome is present for the hover/drop path.
      expect(parent.querySelector('.flbp-drag-handle')).not.toBeNull();
      expect(parent.querySelector('.flbp-list-drag-handle')).not.toBeNull();
    } finally {
      handle!.destroy();
      parent.remove();
    }
  });

  it('falls back to a visible host when parent is missing, headless twin untouched', async () => {
    let fallbackHandle: BlockPageEditorHandle | undefined;
    await act(async () => {
      fallbackHandle = new BlockPageDocumentEditorProvider().createEditor({
        session: {} as never,
        parent: null,
        initialModel: fixture(),
        onDirtyModel: () => undefined,
      });
    });
    try {
      const fallback = document.querySelector('.flbp-fallback-host');
      expect(fallback).not.toBeNull();
      expect(fallback!.querySelector('.ProseMirror')).not.toBeNull();
      expect(
        fallback!.querySelector(`.${hostStyles['froglight-blockpage']}`),
      ).not.toBeNull();
    } finally {
      fallbackHandle!.destroy();
    }
    expect(document.querySelector('.flbp-fallback-host')).toBeNull();

    // Headless twin is untouched: deterministic in-memory edits still work.
    let dirtyCount = 0;
    const headless = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {},
      initialModel: fixture(),
      onDirtyModel: () => {
        dirtyCount += 1;
      },
    });
    headless.appendParagraph('after');
    expect(headless.getModelForTest().rootOrder).toHaveLength(2);
    expect(dirtyCount).toBe(1);
    expect(headless.canExecCommand('undo')).toBe(true);
    headless.destroy();
  });
});

describe('blockpage host styles (token consumer, not token owner)', () => {
  it('defines no:root tokens: values come from the --fl-* contract', () => {
    expect(hostCss.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(
      /^\s*:root\s*\{/m,
    );
  });
});
