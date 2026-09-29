// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentToolSnapshot } from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { defaultToolbarPlacements } from '../toolbar/default-placements.js';
import {
  FloatingToolbarLayer,
  TopbarCenterTools,
  UnifiedToolbarProvider,
} from './UnifiedToolbar.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function snapshot(): DocumentToolSnapshot {
  return {
    context: 'Markdown paragraph',
    controls: [
      {
        kind: 'choice',
        id: 'markdown.block',
        group: 'block',
        label: 'Line style',
        value: 'paragraph',
        options: [{ value: 'paragraph', label: 'Paragraph' }],
      },
    ],
  };
}

describe('single toolbar computation per pane', () => {
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  it('provider shares one model: one subscription per source for two surfaces', async () => {
    const counts = { tools: 0, contributions: 0, placements: 0 };
    const listeners = new Set<() => void>();
    const tools = {
      editorToolSnapshot: () => snapshot(),
      executeEditorTool: () => true,
      canExecEditorCommand: () => true,
      execEditorCommand: () => true,
      onDidChange: (listener: () => void) => {
        counts.tools += 1;
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    } as unknown as WorkbenchEditorToolsPort;
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    for (const placement of defaultToolbarPlacements())
      placements.registry.register(placement);

    // Wrap counting around registries' onDidChange as well.
    const origContribSub = contributions.registry.onDidChange.bind(
      contributions.registry,
    );
    contributions.registry.onDidChange = ((listener: () => void) => {
      counts.contributions += 1;
      return origContribSub(listener);
    }) as typeof contributions.registry.onDidChange;
    const origPlacementSub = placements.registry.onDidChange.bind(
      placements.registry,
    );
    placements.registry.onDidChange = ((listener: () => void) => {
      counts.placements += 1;
      return origPlacementSub(listener);
    }) as typeof placements.registry.onDidChange;

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const props = {
      tools,
      contributions: contributions.registry,
      placements: placements.registry,
      pane: 'main',
      documentId: 'doc-1',
      kindId: 'froglight.markdown',
    };
    await act(async () => {
      root?.render(
        <UnifiedToolbarProvider {...props}>
          <TopbarCenterTools {...props} />
          <FloatingToolbarLayer {...props} />
        </UnifiedToolbarProvider>,
      );
    });
    // One subscription per source for the whole pane (provider), not one per
    // surface (which would be 2 per source).
    expect(counts.tools).toBe(1);
    expect(counts.contributions).toBe(1);
    expect(counts.placements).toBe(1);
    // primaries are composition-owned, so the placement-only
    // topbar-center is empty; the geometric floating layer (history island)
    // proves the shared model still resolved.
    expect(host.querySelector('[data-floating-layer]')).not.toBeNull();
    expect(
      host.querySelector('[data-anchor="float.top-left"] [aria-label="Undo"]'),
    ).not.toBeNull();
    contributions.dispose();
    placements.dispose();
  });

  it('computes the toolbar model once for two surfaces under provider', async () => {
    // Each computeUnifiedToolbarModel calls editorToolSnapshot exactly once,
    // so the snapshot-call count is the computation count. An eager fallback
    // per surface would cost 3 (provider + 2 discarded fallbacks).
    let snapshotCalls = 0;
    const tools = {
      editorToolSnapshot: () => {
        snapshotCalls += 1;
        return snapshot();
      },
      executeEditorTool: () => true,
      canExecEditorCommand: () => true,
      execEditorCommand: () => true,
      onDidChange: () => ({ dispose: () => undefined }),
    } as unknown as WorkbenchEditorToolsPort;
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    for (const placement of defaultToolbarPlacements())
      placements.registry.register(placement);

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const props = {
      tools,
      contributions: contributions.registry,
      placements: placements.registry,
      pane: 'main',
      documentId: 'doc-1',
      kindId: 'froglight.markdown',
    };
    await act(async () => {
      root?.render(
        <UnifiedToolbarProvider {...props}>
          <TopbarCenterTools {...props} />
          <FloatingToolbarLayer {...props} />
        </UnifiedToolbarProvider>,
      );
    });
    // One pane-level computation shared by both surfaces via context.
    expect(snapshotCalls).toBe(1);
    // placement-only topbar-center is empty without composition;
    // the geometric floating layer proves the shared model still resolved.
    expect(host.querySelector('[data-floating-layer]')).not.toBeNull();
    expect(
      host.querySelector('[data-anchor="float.top-left"] [aria-label="Undo"]'),
    ).not.toBeNull();
    contributions.dispose();
    placements.dispose();
  });

  it('computes the fallback model when no provider is present', async () => {
    let snapshotCalls = 0;
    const tools = {
      editorToolSnapshot: () => {
        snapshotCalls += 1;
        return snapshot();
      },
      executeEditorTool: () => true,
      canExecEditorCommand: () => true,
      execEditorCommand: () => true,
      onDidChange: () => ({ dispose: () => undefined }),
    } as unknown as WorkbenchEditorToolsPort;
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    for (const placement of defaultToolbarPlacements())
      placements.registry.register(placement);

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const props = {
      tools,
      contributions: contributions.registry,
      placements: placements.registry,
      pane: 'main',
      documentId: 'doc-1',
      kindId: 'froglight.markdown',
    };
    // Standalone surface without a provider must still compute its model.
    await act(async () => {
      root?.render(<TopbarCenterTools {...props} />);
    });
    expect(snapshotCalls).toBe(1);
    // without composition the placement-only topbar-center is
    // correctly empty (composition owns primaries); the single fallback
    // computation still ran exactly once.
    expect(host.querySelector('[data-toolbar="topbar-center"]')).toBeNull();
    contributions.dispose();
    placements.dispose();
  });
});
