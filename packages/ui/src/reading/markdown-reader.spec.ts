// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { markdownKindId, type DocumentSession } from '@froglight/foundation';
import { workspaceEvents } from '../ui-events.js';
import { MarkdownReaderProvider } from './markdown-reader.js';

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

describe('MarkdownReaderProvider (jsdom)', () => {
  it('renders markdown without a source editor surface', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const provider = new MarkdownReaderProvider();
    const handle = provider.createReader({
      session: makeSession('# Welcome\n\nHello.').session,
      parent,
    });
    const preview = parent.querySelector('.fl-markdown-reader')!;
    expect(preview.innerHTML).toContain('Welcome');
    expect(
      preview.querySelector('[data-document-address="welcome"]'),
    ).not.toBeNull();
    expect(parent.querySelector('.cm-editor')).toBeNull();
    handle.destroy();
  });

  it('re-renders on update and restores/persists scroll', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const loadScroll = vi.fn().mockReturnValue(42);
    const saveScroll = vi.fn();
    const provider = new MarkdownReaderProvider({ loadScroll, saveScroll });
    const { session } = makeSession('# Welcome\n', 'doc-9');
    const handle = provider.createReader({ session, parent });
    expect(loadScroll).toHaveBeenCalledWith('doc-9');
    (session.model as { raw: string }).raw = '# Changed\n';
    handle.update();
    expect(parent.querySelector('.fl-markdown-reader')!.innerHTML).toContain(
      'Changed',
    );
    handle.destroy();
    expect(saveScroll).not.toHaveBeenCalled();
  });

  it('dispatches openLink for wiki-link clicks and reveals addresses', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const provider = new MarkdownReaderProvider();
    const handle = provider.createReader({
      session: makeSession('# Welcome\n\nSee [[Other]].\n').session,
      parent,
    });
    const received: unknown[] = [];
    parent.addEventListener(workspaceEvents.openLink, (event) => {
      received.push((event as CustomEvent).detail);
    });
    parent
      .querySelector('a.wiki-link')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(received).toEqual([{ destination: 'Other' }]);
    expect(() => handle.revealAddress?.('welcome')).not.toThrow();
    handle.destroy();
    expect(parent.querySelector('.fl-markdown-reader')).toBeNull();
  });

  it('binds to the markdown document kind under its own provider id', () => {
    const provider = new MarkdownReaderProvider();
    expect(provider.id).toBe('markdown-reader');
    expect(provider.kindIds).toEqual([markdownKindId]);
  });
});
