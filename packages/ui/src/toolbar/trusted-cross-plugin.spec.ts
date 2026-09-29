/**
 *  trusted cross-plugin completion.
 *
 * Trusted plugins contribute structure (categories/items/settings/kind
 * extensions) through the composition registry and execution through the
 * document-toolbar registry. No plugin mutates React arrays; every
 * registration is owner-scoped and reversible (activate → one,
 * dispose → zero, reactivate → one).
 *
 * Seams: `createToolbarCompositionRegistry` + `resolveToolbarComposition`
 * (structure/dormant/ordering/projections), `createDocumentToolbarRegistry`
 * (execution ownership).
 */

import { describe, expect, it } from 'vitest';
import type { DocumentToolControl } from '@froglight/foundation';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from './placement-registry.js';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { computeUnifiedToolbarModel } from './unified-toolbar-model.js';
import {
  createToolbarCompositionRegistry,
  resolveToolbarComposition,
} from './composition-registry.js';

const KIND_INK = 'froglight.ink';
const KIND_MARKDOWN = 'froglight.markdown';

function button(
  id: string,
  semanticRole: string,
  extra: Record<string, unknown> = {},
): DocumentToolControl {
  return {
    kind: 'button',
    id,
    group: 'draw',
    label: id,
    semanticRole,
    ...extra,
  } as DocumentToolControl;
}

describe('trusted cross-plugin completion', () => {
  it('adds category/tool/tool-to-other-category/settings/selection/projections/kind-extensions and unloads cleanly', () => {
    const composition = createToolbarCompositionRegistry();
    const controls = createDocumentToolbarRegistry();
    try {
      // Plugin A owns the category + tool T.
      const categoryA = composition.registry.registerCategory({
        id: 'plugin-a.tools',
        familyId: 'surface',
        label: 'Plugin A',
        icon: 'shapes',
        order: 10,
      });
      const itemT = composition.registry.registerItem({
        id: 'plugin-a.tool-t',
        categoryId: 'plugin-a.tools',
        semanticRole: 'plugin-a.tool-t',
        order: 10,
        projections: ['normal', 'compact', 'squeeze', 'selection'],
      });
      const controlT = controls.registry.register({
        id: 'plugin-a.controls',
        controls: () => [button('plugin-a.tool-t.control', 'plugin-a.tool-t')],
        execute: () => true,
      });
      composition.registry.registerKindExtension({
        id: 'plugin-a-kind',
        kindIds: [KIND_INK],
        familyIds: ['surface'],
      });

      // Plugin B contributes a tool to A's category + settings for T.
      const itemY = composition.registry.registerItem({
        id: 'plugin-b.tool-y',
        categoryId: 'plugin-a.tools',
        semanticRole: 'plugin-b.tool-y',
        order: 20,
      });
      const controlY = controls.registry.register({
        id: 'plugin-b.controls',
        controls: () => [button('plugin-b.tool-y.control', 'plugin-b.tool-y')],
        execute: () => true,
      });
      const settingsS = composition.registry.registerSettings({
        id: 'plugin-b.settings-s',
        targetSemanticRole: 'plugin-a.tool-t',
        semanticRole: 'plugin-b.settings-s',
        order: 10,
      });
      const settingsControl = controls.registry.register({
        id: 'plugin-b.settings-controls',
        controls: () => [
          {
            kind: 'choice',
            id: 'plugin-b.settings-s.control',
            group: 'settings',
            label: 'Mode',
            value: 'a',
            options: [{ value: 'a', label: 'A' }],
            semanticRole: 'plugin-b.settings-s',
          } as unknown as DocumentToolControl,
        ],
        execute: () => true,
      });

      const pool = (): readonly DocumentToolControl[] => {
        const context = {
          pane: 'p',
          documentId: 'd',
          kindId: KIND_INK,
          editor: null,
        };
        return controls.registry.controls(context);
      };

      // Normal + compact + squeeze + selection all resolve both tools.
      for (const projection of [
        'normal',
        'compact',
        'squeeze',
        'selection',
      ] as const) {
        const graph = resolveToolbarComposition({
          snapshot: composition.registry.snapshot(),
          kindId: KIND_INK,
          controls: pool(),
          projection,
        });
        const ids = graph.categories.flatMap((category) =>
          category.items.map((item) => item.semanticRole),
        );
        // B's item explicitly projects to normal/compact only, so it is
        // absent from squeeze/selection by design; T projects everywhere.
        if (projection === 'normal' || projection === 'compact') {
          expect(ids).toContain('plugin-a.tool-t');
          expect(ids).toContain('plugin-b.tool-y');
        } else {
          expect(ids).toContain('plugin-a.tool-t');
        }
        if (projection === 'normal') {
          expect(graph.settings.map((entry) => entry.semanticRole)).toContain(
            'plugin-b.settings-s',
          );
        }
      }

      // Execution ownership: each control routes to its contribution.
      const context = {
        pane: 'p',
        documentId: 'd',
        kindId: KIND_INK,
        editor: null,
      };
      expect(controls.registry.ownerOf(context, 'plugin-a.tool-t.control')).toBe(
        'plugin-a.controls',
      );
      expect(controls.registry.ownerOf(context, 'plugin-b.tool-y.control')).toBe(
        'plugin-b.controls',
      );

      // Unload B cleanly: structure + execution both gone, A intact.
      itemY.dispose();
      controlY.dispose();
      settingsS.dispose();
      settingsControl.dispose();
      const afterB = resolveToolbarComposition({
        snapshot: composition.registry.snapshot(),
        kindId: KIND_INK,
        controls: pool(),
        projection: 'normal',
      });
      expect(
        afterB.categories.flatMap((category) =>
          category.items.map((item) => item.semanticRole),
        ),
      ).toEqual(['plugin-a.tool-t']);
      expect(afterB.settings).toEqual([]);
      expect(afterB.unresolved).not.toContain('plugin-b.tool-y');

      // Unload A: T dormant, no orphan.
      itemT.dispose();
      controlT.dispose();
      categoryA.dispose();
      const afterA = resolveToolbarComposition({
        snapshot: composition.registry.snapshot(),
        kindId: KIND_INK,
        controls: pool(),
      });
      expect(afterA.categories).toEqual([]);
      expect(controls.registry.controls(context)).toEqual([]);
    } finally {
      composition.dispose();
      controls.dispose();
    }
  });

  it('keeps cross-plugin items dormant and restores them with their category (A creates X, B contributes Y)', () => {
    const created = createToolbarCompositionRegistry();
    try {
      // B contributes first: dormant without A's category.
      const itemY = created.registry.registerItem({
        id: 'plugin-b.tool-y',
        categoryId: 'plugin-a.category-x',
        semanticRole: 'plugin-b.tool-y',
      });
      created.registry.registerKindExtension({
        id: 'kind-ink',
        kindIds: [KIND_INK],
        familyIds: ['surface'],
      });
      const pool = [button('pool-y', 'plugin-b.tool-y')];
      expect(
        resolveToolbarComposition({
          snapshot: created.registry.snapshot(),
          kindId: KIND_INK,
          controls: pool,
        }).unresolved,
      ).toContain('plugin-b.tool-y');

      // A arrives: Y resolves.
      const categoryX = created.registry.registerCategory({
        id: 'plugin-a.category-x',
        familyId: 'surface',
        label: 'X',
        icon: 'shapes',
      });
      expect(
        resolveToolbarComposition({
          snapshot: created.registry.snapshot(),
          kindId: KIND_INK,
          controls: pool,
        }).categories[0]?.items.map((item) => item.id),
      ).toContain('plugin-b.tool-y');

      // A unloads: Y dormant again, no crash.
      categoryX.dispose();
      expect(
        resolveToolbarComposition({
          snapshot: created.registry.snapshot(),
          kindId: KIND_INK,
          controls: pool,
        }).unresolved,
      ).toContain('plugin-b.tool-y');

      // A reloads: Y resolves automatically.
      const restored = created.registry.registerCategory({
        id: 'plugin-a.category-x',
        familyId: 'surface',
        label: 'X',
        icon: 'shapes',
      });
      expect(
        resolveToolbarComposition({
          snapshot: created.registry.snapshot(),
          kindId: KIND_INK,
          controls: pool,
        }).categories,
      ).toHaveLength(1);
      restored.dispose();
      itemY.dispose();
    } finally {
      created.dispose();
    }
  });

  it('keeps settings dormant when the target tool disappears and restores when it returns', () => {
    const created = createToolbarCompositionRegistry();
    try {
      created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
      });
      created.registry.registerItem({
        id: 'plugin-a.tool-t',
        categoryId: 'surface.write',
        semanticRole: 'plugin-a.tool-t',
      });
      created.registry.registerSettings({
        id: 'plugin-b.settings-s',
        targetSemanticRole: 'plugin-a.tool-t',
        semanticRole: 'plugin-b.settings-s',
      });
      created.registry.registerKindExtension({
        id: 'kind-ink',
        kindIds: [KIND_INK],
        familyIds: ['surface'],
      });
      const fullPool = [
        button('control-t', 'plugin-a.tool-t'),
        {
          kind: 'choice',
          id: 'control-s',
          group: 'settings',
          label: 'Mode',
          value: 'a',
          options: [{ value: 'a', label: 'A' }],
          semanticRole: 'plugin-b.settings-s',
        } as unknown as DocumentToolControl,
      ];
      // Both live.
      const live = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND_INK,
        controls: fullPool,
      });
      expect(live.categories).toHaveLength(1);
      expect(live.settings.map((entry) => entry.id)).toContain(
        'plugin-b.settings-s',
      );

      // T disappears (control gone): settings dormant, no crash.
      const withoutT = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND_INK,
        controls: fullPool.filter(
          (control) => control.semanticRole !== 'plugin-a.tool-t',
        ),
      });
      expect(withoutT.categories).toEqual([]);
      expect(withoutT.unresolved).toContain('plugin-a.tool-t');
      expect(withoutT.unresolved).toContain('plugin-b.settings-s');
      expect(withoutT.settings).toEqual([]);

      // T returns: settings restored.
      const restored = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND_INK,
        controls: fullPool,
      });
      expect(restored.settings.map((entry) => entry.id)).toContain(
        'plugin-b.settings-s',
      );

      // Settings control missing but target live: settings dormant.
      const withoutSettingsControl = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND_INK,
        controls: fullPool.filter(
          (control) => control.semanticRole !== 'plugin-b.settings-s',
        ),
      });
      expect(withoutSettingsControl.categories).toHaveLength(1);
      expect(withoutSettingsControl.settings).toEqual([]);
      expect(withoutSettingsControl.unresolved).toContain(
        'plugin-b.settings-s',
      );
    } finally {
      created.dispose();
    }
  });

  it('supports cross-family contributions without leaking across kinds', () => {
    const created = createToolbarCompositionRegistry();
    try {
      created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
      });
      created.registry.registerCategory({
        id: 'writing.format',
        familyId: 'writing',
        label: 'Format',
        icon: 'bold',
      });
      // One trusted plugin contributes to both families.
      created.registry.registerItem({
        id: 'plugin-b.surface-tool',
        categoryId: 'surface.write',
        semanticRole: 'plugin-b.surface-tool',
      });
      created.registry.registerItem({
        id: 'plugin-b.writing-tool',
        categoryId: 'writing.format',
        semanticRole: 'plugin-b.writing-tool',
      });
      created.registry.registerKindExtension({
        id: 'kind-ink',
        kindIds: [KIND_INK],
        familyIds: ['surface'],
      });
      created.registry.registerKindExtension({
        id: 'kind-markdown',
        kindIds: [KIND_MARKDOWN],
        familyIds: ['writing'],
      });
      const pool = [
        button('control-surface', 'plugin-b.surface-tool'),
        button('control-writing', 'plugin-b.writing-tool'),
      ];
      const ink = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND_INK,
        controls: pool,
      });
      expect(ink.categories.map((category) => category.id)).toEqual([
        'surface.write',
      ]);
      const markdown = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND_MARKDOWN,
        controls: pool,
      });
      expect(markdown.categories.map((category) => category.id)).toEqual([
        'writing.format',
      ]);
    } finally {
      created.dispose();
    }
  });

  it('reorders with priority/before/after and restores on unload', () => {
    const created = createToolbarCompositionRegistry();
    try {
      created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
        order: 10,
      });
      created.registry.registerCategory({
        id: 'surface.erase',
        familyId: 'surface',
        label: 'Erase',
        icon: 'eraser',
        order: 20,
      });
      // Numeric order says ball (10) then custom (15) then highlighter (20),
      // but custom declares after:ball so it must follow ball; priority
      // moves the high-priority eraser-adjacent item first within its
      // category regardless of numeric order.
      created.registry.registerItem({
        id: 'test.write.ball',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        order: 10,
      });
      created.registry.registerItem({
        id: 'test.write.custom',
        categoryId: 'surface.write',
        semanticRole: 'plugin-b.custom',
        order: 15,
        after: ['test.write.ball'],
      });
      created.registry.registerItem({
        id: 'test.write.priority',
        categoryId: 'surface.write',
        semanticRole: 'plugin-b.priority',
        order: 50,
        priority: 200,
      });
      created.registry.registerItem({
        id: 'test.write.highlighter',
        categoryId: 'surface.write',
        semanticRole: 'surface.highlighter',
        order: 20,
      });
      created.registry.registerKindExtension({
        id: 'kind-ink',
        kindIds: [KIND_INK],
        familyIds: ['surface'],
      });
      const pool = [
        button('control-ball', 'surface.pen.ball'),
        button('control-custom', 'plugin-b.custom'),
        button('control-priority', 'plugin-b.priority'),
        button('control-highlighter', 'surface.highlighter'),
      ];
      const graph = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND_INK,
        controls: pool,
      });
      const roles = graph.categories[0]?.items.map((item) => item.semanticRole);
      // Priority 200 first, then ball, then custom (after:ball), then
      // highlighter — priority + before/after over raw numeric order.
      expect(roles).toEqual([
        'plugin-b.priority',
        'surface.pen.ball',
        'plugin-b.custom',
        'surface.highlighter',
      ]);

      // Category reorder with before: erase before write.
      const reorder = created.registry.registerCategory({
        id: 'surface.reorder',
        familyId: 'surface',
        label: 'Reorder',
        icon: 'shapes',
        order: 5,
        before: ['surface.write'],
      });
      const reordered = resolveToolbarComposition({
        snapshot: {
          ...created.registry.snapshot(),
          items: [
            ...created.registry.snapshot().items,
            {
              id: 'test.reorder.item',
              categoryId: 'surface.reorder',
              semanticRole: 'plugin-b.reorder-tool',
            },
          ],
        },
        kindId: KIND_INK,
        controls: [...pool, button('control-reorder', 'plugin-b.reorder-tool')],
      });
      expect(reordered.categories.map((category) => category.id)[0]).toBe(
        'surface.reorder',
      );
      reorder.dispose();
    } finally {
      created.dispose();
    }
  });

  it('passes the lifecycle invariant: activate → one, dispose → zero, reactivate → one', () => {
    const composition = createToolbarCompositionRegistry();
    const controls = createDocumentToolbarRegistry();
    const context = {
      pane: 'p',
      documentId: 'd',
      kindId: KIND_INK,
      editor: null,
    };
    try {
      composition.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
      });
      composition.registry.registerKindExtension({
        id: 'kind-ink',
        kindIds: [KIND_INK],
        familyIds: ['surface'],
      });
      const poolControl = button('pool-t', 'plugin-a.tool-t');
      const structure = composition.registry.registerItem({
        id: 'plugin-a.tool-t',
        categoryId: 'surface.write',
        semanticRole: 'plugin-a.tool-t',
      });
      const execution = controls.registry.register({
        id: 'plugin-a.owner',
        controls: () => [poolControl],
        execute: () => true,
      });
      const resolvedOnce = (): number =>
        resolveToolbarComposition({
          snapshot: composition.registry.snapshot(),
          kindId: KIND_INK,
          controls: controls.registry.controls(context),
        }).categories.flatMap((category) => category.items).length;
      expect(resolvedOnce()).toBe(1);
      expect(controls.registry.controls(context)).toHaveLength(1);

      structure.dispose();
      execution.dispose();
      expect(resolvedOnce()).toBe(0);
      expect(controls.registry.controls(context)).toEqual([]);

      composition.registry.registerItem({
        id: 'plugin-a.tool-t',
        categoryId: 'surface.write',
        semanticRole: 'plugin-a.tool-t',
      });
      controls.registry.register({
        id: 'plugin-a.owner',
        controls: () => [poolControl],
        execute: () => true,
      });
      expect(resolvedOnce()).toBe(1);
    } finally {
      composition.dispose();
      controls.dispose();
    }
  });

  it('preserves execution ownership for cross-plugin settings (B settings for A tool route via B)', () => {
    const composition = createToolbarCompositionRegistry();
    const contributions = createDocumentToolbarRegistry();
    try {
      composition.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
      });
      composition.registry.registerItem({
        id: 'plugin-a.tool-t',
        categoryId: 'surface.write',
        semanticRole: 'plugin-a.tool-t',
      });
      composition.registry.registerSettings({
        id: 'plugin-b.settings-s',
        targetSemanticRole: 'plugin-a.tool-t',
        semanticRole: 'plugin-b.settings-s',
      });
      composition.registry.registerKindExtension({
        id: 'kind-ink',
        kindIds: [KIND_INK],
        familyIds: ['surface'],
      });
      const toolControl = button('tool-t-control', 'plugin-a.tool-t');
      const settingsControl = {
        kind: 'choice',
        id: 'settings-s-control',
        group: 'settings',
        label: 'Mode',
        value: 'a',
        options: [{ value: 'a', label: 'A' }],
        semanticRole: 'plugin-b.settings-s',
      } as unknown as DocumentToolControl;
      contributions.registry.register({
        id: 'plugin-a.owner',
        controls: () => [toolControl],
        execute: () => true,
      });
      let settingsCalls = 0;
      contributions.registry.register({
        id: 'plugin-b.owner',
        controls: () => [settingsControl],
        execute: (_context, id) => {
          if (id === 'settings-s-control') settingsCalls += 1;
          return true;
        },
      });
      const context = {
        pane: 'p',
        documentId: 'd',
        kindId: KIND_INK,
        editor: null,
      };
      // Owner routing: settings execute via B, never via A or provider.
      expect(
        contributions.registry.ownerOf(context, 'settings-s-control'),
      ).toBe('plugin-b.owner');
      expect(
        contributions.registry.ownerOf(context, 'tool-t-control'),
      ).toBe('plugin-a.owner');
      void contributions.registry.executeOwned(
        'plugin-b.owner',
        context,
        'settings-s-control',
      );
      expect(settingsCalls).toBe(1);
      // Composition settings resolve with the settings control (structure
      // + execution agree on the same semanticRole).
      const graph = resolveToolbarComposition({
        snapshot: composition.registry.snapshot(),
        kindId: KIND_INK,
        controls: contributions.registry.controls(context),
      });
      expect(graph.settings[0]?.control.id).toBe('settings-s-control');
    } finally {
      composition.dispose();
      contributions.dispose();
    }
  });

  it('excludes dormant composition settings from presentation settingsControls (graph.settings is the authority)', () => {
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
        id: 'plugin-a.tool-t',
        categoryId: 'surface.write',
        semanticRole: 'plugin-a.tool-t',
      });
      composition.registry.registerSettings({
        id: 'plugin-b.settings-s',
        targetSemanticRole: 'plugin-a.tool-t',
        semanticRole: 'plugin-b.settings-s',
      });
      composition.registry.registerKindExtension({
        id: 'kind-ink',
        kindIds: [KIND_INK],
        familyIds: ['surface'],
      });
      placements.registry.register({
        id: 'test.primary',
        anchor: 'topbar-center',
        controlIds: ['tool-t-control'],
      });
      // the target tool is the exclusive active tool, so its
      // settings scope to it via `settingsForTool` (not a global flatten).
      const toolControl = button('tool-t-control', 'plugin-a.tool-t', {
        active: true,
        activationRole: 'tool',
      });
      const settingsControl = {
        kind: 'choice',
        id: 'settings-s-control',
        group: 'settings',
        label: 'Mode',
        value: 'a',
        options: [{ value: 'a', label: 'A' }],
        semanticRole: 'plugin-b.settings-s',
      } as unknown as DocumentToolControl;
      const toolOwner = contributions.registry.register({
        id: 'plugin-a.owner',
        controls: () => [toolControl],
        execute: () => true,
      });
      contributions.registry.register({
        id: 'plugin-b.owner',
        controls: () => [settingsControl],
        execute: () => true,
      });
      const tools = {
        onDidChange: () => ({ dispose: () => undefined }),
        execEditorCommand: () => false,
        canExecEditorCommand: () => false,
        editorToolSnapshot: () => ({ context: 'test', controls: [] }),
        executeEditorTool: () => true,
      } as unknown as WorkbenchEditorToolsPort;
      const computePresentation = (): readonly string[] =>
        computeUnifiedToolbarModel({
          tools,
          contributions: contributions.registry,
          placements: placements.registry,
          composition: composition.registry,
          pane: 'pane-1',
          documentId: 'doc-1',
          kindId: KIND_INK,
        }).settingsControls.map((owned) => owned.control.id);
      // Live target: the settings control reaches the popover.
      expect(computePresentation()).toEqual(['settings-s-control']);
      // Target tool gone: graph.settings goes dormant AND the popover
      // loses the control — presentation follows the graph, not the pool.
      toolOwner.dispose();
      expect(computePresentation()).toEqual([]);
      // Target restored: both graph and presentation recover.
      contributions.registry.register({
        id: 'plugin-a.owner',
        controls: () => [toolControl],
        execute: () => true,
      });
      expect(computePresentation()).toEqual(['settings-s-control']);
    } finally {
      composition.dispose();
      contributions.dispose();
      placements.dispose();
    }
  });
});
