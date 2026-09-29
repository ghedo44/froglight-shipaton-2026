// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markdownKindId, type DocumentSession } from '@froglight/foundation';
import { workspaceEvents } from '../ui-events.js';
import {
  MarkdownReaderProvider,
  type MarkdownReaderDeps,
} from '../reading/markdown-reader.js';
import type { DocumentReaderHandle } from '@froglight/foundation';
import readerStyles from './MarkdownReaderView.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let parent: HTMLElement | null = null;
let handle: DocumentReaderHandle | null = null;

function makeSession(raw: string, documentId = 'doc-1') {
  const dirty = { count: 0 };
  return {
    session: {
      model: { raw },
      document: { documentId, kindId: 'froglight.markdown', location: {} },
      markDirty: () => {
        dirty.count += 1;
      },
    } as unknown as DocumentSession,
    dirty,
  };
}

function mountReader(
  session: DocumentSession,
  deps: MarkdownReaderDeps = {},
): { mounted: HTMLElement; reader: DocumentReaderHandle } {
  parent = document.createElement('div');
  document.body.appendChild(parent);
  const provider = new MarkdownReaderProvider(deps);
  const target = parent;
  let reader: DocumentReaderHandle | null = null;
  act(() => {
    reader = provider.createReader({ session, parent: target });
  });
  handle = reader;
  return { mounted: target, reader: reader as unknown as DocumentReaderHandle };
}

function unmountReader(): void {
  if (handle !== null) {
    const current = handle;
    handle = null;
    act(() => {
      current.destroy();
    });
  }
  parent?.remove();
  parent = null;
}

afterEach(() => {
  unmountReader();
});

describe('MarkdownReaderView (reader seam)', () => {
  it('renders markdown without a source editor surface', () => {
    const { mounted } = mountReader(makeSession('# Welcome\n\nHello.').session);
    const preview = mounted.querySelector('.fl-markdown-reader');
    expect(preview).not.toBeNull();
    expect(preview?.classList.contains(readerStyles.preview)).toBe(true);
    expect(preview?.classList.contains('fl-pane-preview')).toBe(true);
    expect(preview?.classList.contains('fl-markdown-reader')).toBe(true);
    expect(preview?.getAttribute('class')).toBe(
      `${readerStyles.preview} fl-pane-preview fl-markdown-reader`,
    );
    expect(mounted.firstElementChild).toBe(preview);
    expect(preview?.innerHTML).toContain('Welcome');
    expect(
      preview?.querySelector('[data-document-address="welcome"]'),
    ).not.toBeNull();
    expect(mounted.querySelector('.cm-editor')).toBeNull();
  });

  it('re-renders on update and restores/persists scroll', () => {
    const loadScroll = vi.fn().mockReturnValue(42);
    const saveScroll = vi.fn();
    const { session } = makeSession('# Welcome\n', 'doc-9');
    const { mounted, reader } = mountReader(session, {
      loadScroll,
      saveScroll,
    });
    expect(loadScroll).toHaveBeenCalledWith('doc-9');
    (session.model as { raw: string }).raw = '# Changed\n';
    act(() => {
      reader.update();
    });
    expect(mounted.querySelector('.fl-markdown-reader')?.innerHTML).toContain(
      'Changed',
    );
    act(() => {
      reader.destroy();
    });
    handle = null;
    expect(saveScroll).not.toHaveBeenCalled();
  });

  it('dispatches openLink for wiki-link clicks and reveals addresses', () => {
    const { mounted, reader } = mountReader(
      makeSession('# Welcome\n\nSee [[Other]].\n').session,
    );
    const received: unknown[] = [];
    mounted.addEventListener(workspaceEvents.openLink, (event) => {
      received.push((event as CustomEvent).detail);
    });
    act(() => {
      mounted
        .querySelector('a.wiki-link')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(received).toEqual([{ destination: 'Other' }]);
    expect(() => {
      act(() => {
        reader.revealAddress?.('welcome');
      });
    }).not.toThrow();
    act(() => {
      reader.destroy();
    });
    handle = null;
    expect(mounted.querySelector('.fl-markdown-reader')).toBeNull();
  });

  it('binds to the markdown document kind under its own provider id', () => {
    const provider = new MarkdownReaderProvider();
    expect(provider.id).toBe('markdown-reader');
    expect(provider.kindIds).toEqual([markdownKindId]);
  });
});
