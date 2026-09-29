// @vitest-environment jsdom
/**
 * Toolbar fail-soft behavior.
 *
 * - ACTUAL throws degrade + report via `layout.diagnostics`
 *   (existing channel, surfaced through `reportDiagnostics`).
 * - OPTIONAL absent (no composition) stays silent.
 * - Dispatch/teardown never throw outward.
 * - UI never shows sensitive internals (throw text stays in diagnostics,
 *   never in rendered controls/labels).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentToolControl,
  DocumentToolSnapshot,
} from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import type { DocumentToolbarRegistry } from '../document-toolbar-registry.js';
import type { ToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import type { ToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { createToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import { defaultToolbarComposition } from '../toolbar/default-composition.js';
import {
  computeUnifiedToolbarModel,
  FloatingToolbarLayer,
} from './UnifiedToolbar.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function penSnapshot(): DocumentToolSnapshot {
  return {
    context: 'Ink canvas',
    controls: [
      {
        kind: 'button',
        id: 'ink.tool.pen',
        group: 'draw',
        label: 'Ball Pen',
        shortLabel: 'Ball Pen',
        role: 'surface-tool',
        toolId: 'ink.tool.pen',
        semanticRole: 'surface.pen.ball',
        active: true,
        activationRole: 'tool',
      } as unknown as DocumentToolControl,
      {
        kind: 'button',
        id: 'ink.tool.eraser',
        group: 'draw',
        label: 'Eraser',
        shortLabel: 'Eraser',
        role: 'surface-tool',
        toolId: 'ink.tool.eraser',
        semanticRole: 'surface.erase',
        active: false,
        activationRole: 'tool',
      } as unknown as DocumentToolControl,
    ],
  };
}

function installDefaults(registry: ToolbarCompositionRegistry): void {
  const defaults = defaultToolbarComposition();
  for (const entry of defaults.categories) registry.registerCategory(entry);
  for (const entry of defaults.items) registry.registerItem(entry);
  for (const entry of defaults.extensions)
    registry.registerKindExtension(entry);
}

function baseHarness() {
  const contributions = createDocumentToolbarRegistry();
  const placements = createToolbarPlacementRegistry();
  const composition = createToolbarCompositionRegistry();
  installDefaults(composition.registry);
  const healthyTools: WorkbenchEditorToolsPort = {
    onDidChange: () => ({ dispose: () => undefined }),
    execEditorCommand: () => false,
    canExecEditorCommand: () => true,
    editorToolSnapshot: () => penSnapshot(),
    executeEditorTool: () => true,
  } as unknown as WorkbenchEditorToolsPort;
  return { contributions, placements, composition, healthyTools };
}

describe('toolbar fail-soft probes (H6-TB)', () => {
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('throwing tool snapshot degrades + reports without crashing', () => {
    const { contributions, placements, composition } = baseHarness();
    try {
      const tools = {
        onDidChange: () => ({ dispose: () => undefined }),
        execEditorCommand: () => false,
        canExecEditorCommand: () => true,
        editorToolSnapshot: () => {
          throw new Error('snapshot boom SECRET_TOOLBAR_X1');
        },
        executeEditorTool: () => true,
      } as unknown as WorkbenchEditorToolsPort;
      let threw = false;
      let computed: ReturnType<typeof computeUnifiedToolbarModel> | null = null;
      try {
        computed = computeUnifiedToolbarModel({
          tools,
          contributions: contributions.registry,
          placements: placements.registry,
          composition: composition.registry,
          pane: 'main',
          documentId: 'doc-1',
          kindId: 'froglight.ink',
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(computed).not.toBeNull();
      expect(computed!.snapshot).toBeNull();
      expect(computed!.layout.diagnostics.join('\n')).toContain(
        'toolbar tool snapshot probe failed',
      );
      // Sanitized: message present, stack never in diagnostics.
      expect(computed!.layout.diagnostics.join('\n')).toContain('snapshot boom');
      for (const diagnostic of computed!.layout.diagnostics) {
        expect(diagnostic).not.toMatch(/at\s+\S+\s*\(/);
      }
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  it('throwing contribution entries degrades to provider tools + reports', () => {
    const { placements, composition, healthyTools } = baseHarness();
    const contributions = createDocumentToolbarRegistry();
    try {
      const throwing = {
        ...contributions.registry,
        entries: () => {
          throw new Error('contribution boom SECRET_TOOLBAR_X2');
        },
      } as unknown as DocumentToolbarRegistry;
      const computed = computeUnifiedToolbarModel({
        tools: healthyTools,
        contributions: throwing,
        placements: placements.registry,
        composition: composition.registry,
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      });
      // Provider pen still resolves despite the registry failure.
      expect(computed.ownedById.get('ink.tool.pen')).toBeDefined();
      expect(computed.layout.diagnostics.join('\n')).toContain(
        'toolbar contribution entries failed',
      );
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  it('throwing placements + history probes degrade + report', () => {
    const { contributions, composition, healthyTools } = baseHarness();
    const placements = createToolbarPlacementRegistry();
    try {
      const throwingPlacements = {
        ...placements.registry,
        placementsFor: () => {
          throw new Error('placement boom SECRET_TOOLBAR_X3');
        },
      } as unknown as ToolbarPlacementRegistry;
      const throwingTools = {
        ...healthyTools,
        canExecEditorCommand: () => {
          throw new Error('history boom SECRET_TOOLBAR_X4');
        },
      } as unknown as WorkbenchEditorToolsPort;
      const computed = computeUnifiedToolbarModel({
        tools: throwingTools,
        contributions: contributions.registry,
        placements: throwingPlacements,
        composition: composition.registry,
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      });
      // Degrades to disabled history, empty placements (built-in history
      // still budgets through the fallback path).
      expect(computed.canUndo).toBe(false);
      expect(computed.canRedo).toBe(false);
      const joined = computed.layout.diagnostics.join('\n');
      expect(joined).toContain('toolbar placement resolution failed');
      expect(joined).toContain('toolbar history probe failed');
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  it('throwing composition snapshot degrades + reports; optional absent stays silent', () => {
    const { contributions, placements, healthyTools } = baseHarness();
    const composition = createToolbarCompositionRegistry();
    try {
      installDefaults(composition.registry);
      const throwing = {
        ...composition.registry,
        snapshot: () => {
          throw new Error('composition boom SECRET_TOOLBAR_X5');
        },
      } as unknown as ToolbarCompositionRegistry;
      const degraded = computeUnifiedToolbarModel({
        tools: healthyTools,
        contributions: contributions.registry,
        placements: placements.registry,
        composition: throwing,
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      });
      expect(degraded.compositionGraph).toBeNull();
      expect(degraded.layout.diagnostics.join('\n')).toContain(
        'toolbar composition snapshot failed',
      );
      // OPTIONAL absent: no composition registry → no probe, no diagnostic,
      // and the model still resolves placements.
      const absent = computeUnifiedToolbarModel({
        tools: healthyTools,
        contributions: contributions.registry,
        placements: placements.registry,
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      });
      expect(absent.compositionGraph).toBeNull();
      expect(
        absent.layout.diagnostics.join('\n'),
      ).not.toContain('toolbar composition snapshot failed');
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  it('dispatch + teardown never throw; UI never shows sensitive internals', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    try {
      installDefaults(composition.registry);
      const tools = {
        onDidChange: () => ({
          dispose: () => {
            throw new Error('dispose boom SECRET_TOOLBAR_X6');
          },
        }),
        execEditorCommand: () => {
          throw new Error('history exec boom SECRET_TOOLBAR_X7');
        },
        canExecEditorCommand: () => true,
        editorToolSnapshot: () => penSnapshot(),
        executeEditorTool: () => {
          throw new Error('execute boom SECRET_TOOLBAR_X8');
        },
      } as unknown as WorkbenchEditorToolsPort;
      let threw = false;
      try {
        await act(async () => {
          root?.render(
            <FloatingToolbarLayer
              tools={tools}
              contributions={contributions.registry}
              placements={placements.registry}
              composition={composition.registry}
              pane="main"
              documentId="doc-1"
              kindId="froglight.ink"
            />,
          );
        });
        // Dispatch through the mounted shelf tool button (execute throws).
        const trigger = host.querySelector(
          '[data-tool-shelf="surface.write"] button[aria-label="Ball Pen"]',
        );
        if (trigger instanceof HTMLButtonElement) {
          await act(async () => trigger.click());
        }
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      // Throw text reaches the dev diagnostic channel, never visible UI.
      const messages = error.mock.calls
        .map((call) => String(call[0] ?? ''))
        .join('\n');
      expect(messages).toContain('toolbar execute');
      const visibleText = host.textContent ?? '';
      expect(visibleText).not.toContain('SECRET_TOOLBAR_X8');
      expect(visibleText).not.toContain('boom');
      // Teardown with a throwing disposer never throws outward.
      try {
        await act(async () => root?.unmount());
        root = null;
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  it('subscribing with a throwing onDidChange never breaks mount', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    try {
      installDefaults(composition.registry);
      const tools = {
        onDidChange: () => {
          throw new Error('subscribe boom SECRET_TOOLBAR_X9');
        },
        execEditorCommand: () => false,
        canExecEditorCommand: () => true,
        editorToolSnapshot: () => penSnapshot(),
        executeEditorTool: () => true,
      } as unknown as WorkbenchEditorToolsPort;
      let threw = false;
      try {
        await act(async () => {
          root?.render(
            <FloatingToolbarLayer
              tools={tools}
              contributions={contributions.registry}
              placements={placements.registry}
              composition={composition.registry}
              pane="main"
              documentId="doc-1"
              kindId="froglight.ink"
            />,
          );
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(
        host.querySelector('[data-tool-shelf="surface.write"]'),
      ).not.toBeNull();
      await act(async () => root?.unmount());
      root = null;
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });
});
