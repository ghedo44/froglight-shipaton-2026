/**
 *  Scope toolbar settings to their target tool.
 *
 * Plugin A tools T,U; Plugin B settings S targeting T:
 * T active → S available; U active → S not presented;
 * T disappears → S dormant (graph.unresolved); T returns → S restores;
 * settings control disappears independently handled;
 * cross-plugin ownership preserved; multiple providers targeting one tool;
 * two tools same category incl. Pen → Pencil transition.
 *
 * Seam: `computeUnifiedToolbarModel` settingsControls + `settingsForTool`
 * helper in composition-registry (semantic grouping, not UI string guessing).
 */

import { describe, expect, it } from 'vitest';
import type { DocumentToolControl } from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from './placement-registry.js';
import {
  createToolbarCompositionRegistry,
  resolveToolbarComposition,
  settingsForTool,
} from './composition-registry.js';
import { computeUnifiedToolbarModel } from './unified-toolbar-model.js';

const KIND = 'froglight.ink';

function toolControl(
  id: string,
  semanticRole: string,
  active: boolean,
): DocumentToolControl {
  return {
    kind: 'button',
    id,
    group: 'draw',
    label: id,
    semanticRole,
    active,
    activationRole: 'tool',
  } as DocumentToolControl;
}

function settingsControl(
  id: string,
  semanticRole: string,
): DocumentToolControl {
  return {
    kind: 'choice',
    id,
    group: 'settings',
    label: id,
    value: 'a',
    options: [{ value: 'a', label: 'A' }],
    semanticRole,
  } as unknown as DocumentToolControl;
}

function toolsPortFor(
  controls: readonly DocumentToolControl[],
): WorkbenchEditorToolsPort {
  return {
    onDidChange: () => ({ dispose: () => undefined }),
    execEditorCommand: () => false,
    canExecEditorCommand: () => false,
    editorToolSnapshot: () => ({ context: 'test', controls: [...controls] }),
    executeEditorTool: () => true,
  } as unknown as WorkbenchEditorToolsPort;
}

function setupTwoTools() {
  const composition = createToolbarCompositionRegistry();
  const contributions = createDocumentToolbarRegistry();
  const placements = createToolbarPlacementRegistry();
  composition.registry.registerCategory({
    id: 'plugin-a.tools',
    familyId: 'surface',
    label: 'Tools',
    icon: 'shapes',
  });
  composition.registry.registerItem({
    id: 'plugin-a.tool-t',
    categoryId: 'plugin-a.tools',
    semanticRole: 'plugin-a.tool-t',
  });
  composition.registry.registerItem({
    id: 'plugin-a.tool-u',
    categoryId: 'plugin-a.tools',
    semanticRole: 'plugin-a.tool-u',
  });
  composition.registry.registerSettings({
    id: 'plugin-b.settings-s',
    targetSemanticRole: 'plugin-a.tool-t',
    semanticRole: 'plugin-b.settings-s',
  });
  composition.registry.registerKindExtension({
    id: 'kind-ink',
    kindIds: [KIND],
    familyIds: ['surface'],
  });
  placements.registry.register({
    id: 'test.primary',
    anchor: 'topbar-center',
    controlIds: ['tool-t', 'tool-u'],
  });
  // Plugin B owns the settings execution.
  contributions.registry.register({
    id: 'plugin-b.owner',
    controls: () => [settingsControl('settings-s', 'plugin-b.settings-s')],
    execute: () => true,
  });
  const computeWith = (activeId: 'tool-t' | 'tool-u'): readonly string[] => {
    const tools = toolsPortFor([
      toolControl('tool-t', 'plugin-a.tool-t', activeId === 'tool-t'),
      toolControl('tool-u', 'plugin-a.tool-u', activeId === 'tool-u'),
      // Settings control lives in the owned pool via contribution; provider
      // snapshot only carries the tools so active-tool toggling is explicit.
    ]);
    return computeUnifiedToolbarModel({
      tools,
      contributions: contributions.registry,
      placements: placements.registry,
      composition: composition.registry,
      pane: 'p',
      documentId: 'd',
      kindId: KIND,
    }).settingsControls.map((owned) => owned.control.id);
  };
  return { composition, contributions, placements, computeWith };
}

describe('scoped toolbar settings (Repair 2)', () => {
  it('presents S only for its target tool T, not for sibling U', () => {
    const h = setupTwoTools();
    try {
      expect(h.computeWith('tool-t')).toEqual(['settings-s']);
      expect(h.computeWith('tool-u')).toEqual([]);
    } finally {
      h.composition.dispose();
      h.contributions.dispose();
      h.placements.dispose();
    }
  });

  it('keeps S dormant when T disappears and restores when T returns', () => {
    const composition = createToolbarCompositionRegistry();
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    try {
      composition.registry.registerCategory({
        id: 'plugin-a.tools',
        familyId: 'surface',
        label: 'Tools',
        icon: 'shapes',
      });
      composition.registry.registerItem({
        id: 'plugin-a.tool-t',
        categoryId: 'plugin-a.tools',
        semanticRole: 'plugin-a.tool-t',
      });
      composition.registry.registerItem({
        id: 'plugin-a.tool-u',
        categoryId: 'plugin-a.tools',
        semanticRole: 'plugin-a.tool-u',
      });
      composition.registry.registerSettings({
        id: 'plugin-b.settings-s',
        targetSemanticRole: 'plugin-a.tool-t',
        semanticRole: 'plugin-b.settings-s',
      });
      composition.registry.registerKindExtension({
        id: 'kind-ink',
        kindIds: [KIND],
        familyIds: ['surface'],
      });
      placements.registry.register({
        id: 'test.primary',
        anchor: 'topbar-center',
        controlIds: ['tool-t', 'tool-u'],
      });
      contributions.registry.register({
        id: 'plugin-b.owner',
        controls: () => [settingsControl('settings-s', 'plugin-b.settings-s')],
        execute: () => true,
      });
      const computeFor = (
        tools: readonly DocumentToolControl[],
      ): { ids: readonly string[]; unresolved: readonly string[] } => {
        const port = toolsPortFor(tools);
        const computed = computeUnifiedToolbarModel({
          tools: port,
          contributions: contributions.registry,
          placements: placements.registry,
          composition: composition.registry,
          pane: 'p',
          documentId: 'd',
          kindId: KIND,
        });
        return {
          ids: computed.settingsControls.map((owned) => owned.control.id),
          unresolved: computed.compositionGraph?.unresolved ?? [],
        };
      };
      const liveT = toolControl('tool-t', 'plugin-a.tool-t', true);
      const liveU = toolControl('tool-u', 'plugin-a.tool-u', false);
      // T live + active → S presented.
      expect(computeFor([liveT, liveU]).ids).toEqual(['settings-s']);
      // T control gone (U active instead) → S dormant in unresolved, not presented.
      const withoutT = computeFor([
        toolControl('tool-u', 'plugin-a.tool-u', true),
      ]);
      expect(withoutT.ids).toEqual([]);
      expect(withoutT.unresolved).toContain('plugin-b.settings-s');
      // T returns → S restores.
      expect(computeFor([liveT, liveU]).ids).toEqual(['settings-s']);
      // Settings control missing but target live → dormant, not presented.
      const toolOwnerGone = computeFor([liveT, liveU]);
      expect(toolOwnerGone.ids).toEqual(['settings-s']);
      contributions.dispose();
      const freshContributions = createDocumentToolbarRegistry();
      const port = toolsPortFor([liveT, liveU]);
      const computed = computeUnifiedToolbarModel({
        tools: port,
        contributions: freshContributions.registry,
        placements: placements.registry,
        composition: composition.registry,
        pane: 'p',
        documentId: 'd',
        kindId: KIND,
      });
      expect(
        computed.settingsControls.map((owned) => owned.control.id),
      ).toEqual([]);
      expect(computed.compositionGraph?.unresolved).toContain(
        'plugin-b.settings-s',
      );
      freshContributions.dispose();
    } finally {
      composition.dispose();
      contributions.dispose();
      placements.dispose();
    }
  });

  it('preserves cross-plugin ownership through the scoped path', () => {
    const h = setupTwoTools();
    try {
      const tools = toolsPortFor([
        toolControl('tool-t', 'plugin-a.tool-t', true),
        toolControl('tool-u', 'plugin-a.tool-u', false),
      ]);
      const computed = computeUnifiedToolbarModel({
        tools,
        contributions: h.contributions.registry,
        placements: h.placements.registry,
        composition: h.composition.registry,
        pane: 'p',
        documentId: 'd',
        kindId: KIND,
      });
      expect(computed.settingsControls[0]?.owner).toEqual({
        kind: 'contribution',
        contributionId: 'plugin-b.owner',
      });
      expect(
        h.contributions.registry.ownerOf(
          { pane: 'p', documentId: 'd', kindId: KIND, editor: null },
          'settings-s',
        ),
      ).toBe('plugin-b.owner');
    } finally {
      h.composition.dispose();
      h.contributions.dispose();
      h.placements.dispose();
    }
  });

  it('presents multiple providers targeting one tool together', () => {
    const composition = createToolbarCompositionRegistry();
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    try {
      composition.registry.registerCategory({
        id: 'plugin-a.tools',
        familyId: 'surface',
        label: 'Tools',
        icon: 'shapes',
      });
      composition.registry.registerItem({
        id: 'plugin-a.tool-t',
        categoryId: 'plugin-a.tools',
        semanticRole: 'plugin-a.tool-t',
      });
      composition.registry.registerItem({
        id: 'plugin-a.tool-u',
        categoryId: 'plugin-a.tools',
        semanticRole: 'plugin-a.tool-u',
      });
      composition.registry.registerSettings({
        id: 'plugin-b.settings-s1',
        targetSemanticRole: 'plugin-a.tool-t',
        semanticRole: 'plugin-b.settings-s1',
      });
      composition.registry.registerSettings({
        id: 'plugin-c.settings-s2',
        targetSemanticRole: 'plugin-a.tool-t',
        semanticRole: 'plugin-c.settings-s2',
      });
      composition.registry.registerKindExtension({
        id: 'kind-ink',
        kindIds: [KIND],
        familyIds: ['surface'],
      });
      placements.registry.register({
        id: 'test.primary',
        anchor: 'topbar-center',
        controlIds: ['tool-t', 'tool-u'],
      });
      contributions.registry.register({
        id: 'plugin-b.owner',
        controls: () => [settingsControl('settings-s1', 'plugin-b.settings-s1')],
        execute: () => true,
      });
      contributions.registry.register({
        id: 'plugin-c.owner',
        controls: () => [settingsControl('settings-s2', 'plugin-c.settings-s2')],
        execute: () => true,
      });
      const computeIds = (activeId: 'tool-t' | 'tool-u'): readonly string[] => {
        const tools = toolsPortFor([
          toolControl('tool-t', 'plugin-a.tool-t', activeId === 'tool-t'),
          toolControl('tool-u', 'plugin-a.tool-u', activeId === 'tool-u'),
        ]);
        return computeUnifiedToolbarModel({
          tools,
          contributions: contributions.registry,
          placements: placements.registry,
          composition: composition.registry,
          pane: 'p',
          documentId: 'd',
          kindId: KIND,
        }).settingsControls.map((owned) => owned.control.id);
      };
      expect([...computeIds('tool-t')].sort()).toEqual([
        'settings-s1',
        'settings-s2',
      ]);
      expect(computeIds('tool-u')).toEqual([]);
    } finally {
      composition.dispose();
      contributions.dispose();
      placements.dispose();
    }
  });

  it('switches scoped settings on same-category Pen → Pencil transition', () => {
    const composition = createToolbarCompositionRegistry();
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    try {
      composition.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
      });
      composition.registry.registerItem({
        id: 'item-pen',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
      });
      composition.registry.registerItem({
        id: 'item-pencil',
        categoryId: 'surface.write',
        semanticRole: 'surface.pencil',
      });
      composition.registry.registerSettings({
        id: 'settings-pen',
        targetSemanticRole: 'surface.pen.ball',
        semanticRole: 'surface.settings.pen-size',
      });
      composition.registry.registerSettings({
        id: 'settings-pencil',
        targetSemanticRole: 'surface.pencil',
        semanticRole: 'surface.settings.pencil-size',
      });
      composition.registry.registerKindExtension({
        id: 'kind-ink',
        kindIds: [KIND],
        familyIds: ['surface'],
      });
      placements.registry.register({
        id: 'test.primary',
        anchor: 'topbar-center',
        controlIds: ['ink.pen', 'ink.pencil'],
      });
      contributions.registry.register({
        id: 'settings.owner',
        controls: () => [
          settingsControl('pen-size', 'surface.settings.pen-size'),
          settingsControl('pencil-size', 'surface.settings.pencil-size'),
        ],
        execute: () => true,
      });
      const computeIds = (activeId: string): readonly string[] => {
        const tools = toolsPortFor([
          toolControl('ink.pen', 'surface.pen.ball', activeId === 'ink.pen'),
          toolControl('ink.pencil', 'surface.pencil', activeId === 'ink.pencil'),
        ]);
        return computeUnifiedToolbarModel({
          tools,
          contributions: contributions.registry,
          placements: placements.registry,
          composition: composition.registry,
          pane: 'p',
          documentId: 'd',
          kindId: KIND,
        }).settingsControls.map((owned) => owned.control.id);
      };
      expect(computeIds('ink.pen')).toEqual(['pen-size']);
      expect(computeIds('ink.pencil')).toEqual(['pencil-size']);
    } finally {
      composition.dispose();
      contributions.dispose();
      placements.dispose();
    }
  });

  it('settingsForTool groups by targetSemanticRole from the resolved graph', () => {
    const created = createToolbarCompositionRegistry();
    try {
      created.registry.registerCategory({
        id: 'plugin-a.tools',
        familyId: 'surface',
        label: 'Tools',
        icon: 'shapes',
      });
      created.registry.registerItem({
        id: 'plugin-a.tool-t',
        categoryId: 'plugin-a.tools',
        semanticRole: 'plugin-a.tool-t',
      });
      created.registry.registerItem({
        id: 'plugin-a.tool-u',
        categoryId: 'plugin-a.tools',
        semanticRole: 'plugin-a.tool-u',
      });
      created.registry.registerSettings({
        id: 'plugin-b.settings-s',
        targetSemanticRole: 'plugin-a.tool-t',
        semanticRole: 'plugin-b.settings-s',
      });
      created.registry.registerKindExtension({
        id: 'kind-ink',
        kindIds: [KIND],
        familyIds: ['surface'],
      });
      const pool: readonly DocumentToolControl[] = [
        toolControl('tool-t', 'plugin-a.tool-t', true),
        toolControl('tool-u', 'plugin-a.tool-u', false),
        settingsControl('settings-s', 'plugin-b.settings-s'),
      ];
      const graph = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND,
        controls: pool,
      });
      expect(
        settingsForTool(graph, 'plugin-a.tool-t').map((s) => s.id),
      ).toEqual(['plugin-b.settings-s']);
      expect(settingsForTool(graph, 'plugin-a.tool-u')).toEqual([]);
      expect(settingsForTool(graph, null)).toEqual([]);
      expect(settingsForTool(null, 'plugin-a.tool-t')).toEqual([]);
    } finally {
      created.dispose();
    }
  });
});
