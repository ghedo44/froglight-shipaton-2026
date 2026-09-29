// @vitest-environment jsdom
import { act } from 'react';
import { InMemoryNavigationService } from '@froglight/foundation';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceEvents as events } from '../../../ui-events.js';
import { PREVIEW_VIEW_ID_PREFIX } from '../../../view-registry.js';
import type { WorkspaceDocumentIntent } from '../routing/documentRouter.js';
import { useWorkspaceDocumentIntentEvents } from './useWorkspaceDocumentIntentEvents.js';
import { createElement } from 'react';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function setup(navigation?: InMemoryNavigationService): {
  root: HTMLElement;
  target: HTMLElement;
  intents: WorkspaceDocumentIntent[];
  dispose: () => void;
} {
  const intents: WorkspaceDocumentIntent[] = [];
  const router = {
    dispatch: vi.fn(async (intent: WorkspaceDocumentIntent) => {
      intents.push(intent);
    }),
  };
  const root = document.createElement('div');
  document.body.appendChild(root);
  const target = document.createElement('div');
  root.appendChild(target);
  function Probe(): React.ReactElement {
    useWorkspaceDocumentIntentEvents({
      router,
      ...(navigation === undefined ? {} : { navigation }),
      resolveResource: (resourceId) =>
        resourceId === 'resource-target' ? 'document-target' : undefined,
      eventTarget: target,
      getRoot: () => root,
    });
    return createElement('div');
  }
  const reactRoot: Root = createRoot(target);
  act(() => {
    reactRoot.render(createElement(Probe));
  });
  return {
    root,
    target,
    intents,
    dispose: () => {
      act(() => {
        reactRoot.unmount();
      });
      root.remove();
    },
  };
}

function dispatch(target: HTMLElement, type: string, detail: unknown): void {
  act(() => {
    target.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  });
}

describe('workspace document intent events (adapter)', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('routes provider resource navigation and releases its subscription on unmount', () => {
    const navigation = new InMemoryNavigationService();
    navigation.push({ resourceId: 'old' });
    const h = setup(navigation);
    cleanup = h.dispose;
    expect(h.intents).toEqual([]);
    act(() =>
      navigation.push({ resourceId: 'resource-target', address: 'block-2' }),
    );
    expect(h.intents).toEqual([
      {
        type: 'open-document',
        documentId: 'document-target',
        address: 'block-2',
        disposition: 'foreground',
      },
    ]);
    h.dispose();
    cleanup = null;
    act(() => navigation.push({ resourceId: 'after-dispose' }));
    expect(h.intents).toHaveLength(1);
  });

  it('maps open to a foreground document intent', () => {
    const h = setup();
    cleanup = h.dispose;
    dispatch(h.target, events.open, {
      documentId: 'doc-1',
      address: 'slug',
    });
    expect(h.intents).toEqual([
      {
        type: 'open-document',
        documentId: 'doc-1',
        address: 'slug',
        disposition: 'foreground',
      },
    ]);
  });

  it('maps open-background with a document to a background intent', () => {
    const h = setup();
    cleanup = h.dispose;
    dispatch(h.target, events.openBackground, { documentId: 'doc-2' });
    expect(h.intents).toEqual([
      { type: 'open-document', documentId: 'doc-2', disposition: 'background' },
    ]);
  });

  it('maps open-background with a preview view id to a background preview intent', () => {
    const h = setup();
    cleanup = h.dispose;
    dispatch(h.target, events.openBackground, {
      viewId: `${PREVIEW_VIEW_ID_PREFIX}a.png`,
    });
    expect(h.intents).toEqual([
      { type: 'open-preview', path: 'a.png', disposition: 'background' },
    ]);
  });

  it('maps open-background with a generic view id to a background view intent', () => {
    const h = setup();
    cleanup = h.dispose;
    dispatch(h.target, events.openBackground, { viewId: 'graph' });
    expect(h.intents).toEqual([
      { type: 'open-view', viewId: 'graph', disposition: 'background' },
    ]);
  });

  it('maps open-view to a foreground view intent', () => {
    const h = setup();
    cleanup = h.dispose;
    dispatch(h.target, events.openView, { viewId: 'graph' });
    expect(h.intents).toEqual([
      { type: 'open-view', viewId: 'graph', disposition: 'foreground' },
    ]);
  });

  it('maps open-link, open-preview, move, delete, and documents-deleted', () => {
    const h = setup();
    cleanup = h.dispose;
    dispatch(h.target, events.openLink, { destination: 'Welcome' });
    dispatch(h.target, events.openPreview, { path: 'a.png' });
    dispatch(h.target, events.previewMoved, { from: 'a.png', to: 'b.png' });
    dispatch(h.target, events.previewDeleted, { path: 'a.png' });
    dispatch(h.target, events.documentsDeleted, {});
    expect(h.intents).toEqual([
      { type: 'open-link', destination: 'Welcome' },
      { type: 'open-preview', path: 'a.png', disposition: 'foreground' },
      { type: 'preview-moved', from: 'a.png', to: 'b.png' },
      { type: 'preview-deleted', path: 'a.png' },
      { type: 'documents-deleted' },
    ]);
  });

  it('ignores malformed payloads without dispatching', () => {
    const h = setup();
    cleanup = h.dispose;
    dispatch(h.target, events.open, {});
    dispatch(h.target, events.open, { documentId: '' });
    dispatch(h.target, events.openBackground, {});
    dispatch(h.target, events.openLink, { destination: '' });
    dispatch(h.target, events.openPreview, { path: '' });
    dispatch(h.target, events.previewMoved, { from: 'a.png' });
    dispatch(h.target, events.previewMoved, { from: '', to: 'b.png' });
    dispatch(h.target, events.previewMoved, { from: 'a.png', to: '' });
    dispatch(h.target, events.previewDeleted, {});
    dispatch(h.target, events.previewDeleted, { path: '' });
    expect(h.intents).toEqual([]);
  });
});
