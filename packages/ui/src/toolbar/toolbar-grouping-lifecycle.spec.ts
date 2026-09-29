/**
 * Toolbar grouping lifecycle invariant + cascade suite.
 *
 * Tests-only. Covers every touched registration API:
 * - composition (registerCategory/Item/Settings/KindExtension, onDidChange,
 *   toolbarCompositionPlugin effect ownership)
 * - customization-backed slot overrides (ToolbarCustomizationStore lifecycle)
 * - shelf/utility placements incl. cross-layer (placement registry +
 *   defaultToolbarPlacements + computeUnifiedToolbarModel cross-layer
 *   diagnostic lifecycle)
 * - family contributions (defaultToolbarComposition categories/items/
 *   extensions per family)
 * - community lifecycle (registerCommunityToolbarContribution + host)
 *
 * Invariants per API (repository lifecycle invariant):
 *   activate -> one registration
 *   dispose -> zero registrations
 *   reactivate -> one registration
 * Same-id shadow/restore and provider-swap multi-level cascade with no
 * dangling services/listeners/effects. Text-pair allowlist vs all-other-
 * duplicates diagnostic (composition duplicate-presenter + cross-layer
 * diagnostic). The suite fails on any leaked registration or
 * missing diagnostic.
 *
 * Scope: lifecycle and invariant specs only. Responsive/accessibility
 * geometry and snapshot regeneration are covered elsewhere.
 */

import { describe, expect, it, vi } from 'vitest';
import { Runtime, createServiceToken, definePlugin } from '@froglight/runtime';
import {
  InMemorySettingsService,
  type DocumentToolControl,
} from '@froglight/foundation';
import {
  SURFACE_TEXT_CREATE_ITEM_ID,
  SURFACE_TEXT_CREATION_ROLE,
  SURFACE_TEXT_INSERT_ITEM_ID,
  createToolbarCompositionRegistry,
  resolveToolbarComposition,
  toolbarCompositionPlugin,
  toolbarCompositionToken,
} from './composition-registry.js';
import {
  createToolbarPlacementRegistry,
  documentToolbarPlacementPlugin,
  documentToolbarPlacementToken,
} from './placement-registry.js';
import {
  createDocumentToolbarRegistry,
  type DocumentToolbarContext,
} from '../document-toolbar-registry.js';
import {
  TOOLBAR_CUSTOMIZATION_STORAGE_KEY,
  ToolbarCustomizationStore,
} from './toolbar-customization.js';
import { defaultToolbarComposition } from './default-composition.js';
import { defaultToolbarPlacements } from './default-placements.js';
import { registerCommunityToolbarContribution } from './community-contribution.js';
import { createCommunityToolbarHost } from './community-lifecycle.js';
import { computeUnifiedToolbarModel } from './unified-toolbar-model.js';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';

function context(kindId: string): DocumentToolbarContext {
  return {
    pane: 'main',
    documentId: 'doc-1',
    kindId,
    editor: { context: 'test', controls: [] },
  };
}

function button(id: string, semanticRole?: string): DocumentToolControl {
  return {
    kind: 'button',
    id,
    group: 'test',
    label: id,
    ...(semanticRole !== undefined ? { semanticRole } : {}),
  } as DocumentToolControl;
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

function installDefaultComposition(
  registry: ReturnType<typeof createToolbarCompositionRegistry>['registry'],
): void {
  const defaults = defaultToolbarComposition();
  for (const entry of defaults.categories) registry.registerCategory(entry);
  for (const entry of defaults.items) registry.registerItem(entry);
  for (const entry of defaults.extensions)
    registry.registerKindExtension(entry);
}

function pdfControls(): DocumentToolControl[] {
  return [
    {
      kind: 'button',
      id: 'pdf.previous',
      group: 'pages',
      label: 'Previous PDF page',
      shortLabel: 'Previous',
      semanticRole: 'pdf.page.previous',
    },
    { kind: 'status', id: 'pdf.page', group: 'pages', label: '3 / 9' },
    {
      kind: 'button',
      id: 'pdf.next',
      group: 'pages',
      label: 'Next PDF page',
      shortLabel: 'Next',
      semanticRole: 'pdf.page.next',
    },
    {
      kind: 'button',
      id: 'pdf.source-select',
      group: 'interaction',
      label: 'Select and copy source text',
      shortLabel: 'Source Select',
      semanticRole: 'pdf.select.source',
      activationRole: 'toggle',
    },
    {
      kind: 'button',
      id: 'pdf.import-notebook',
      group: 'document',
      label: 'Annotate / Import as Notebook',
      shortLabel: 'Annotate',
      semanticRole: 'pdf.annotate.notebook',
    },
  ] as unknown as DocumentToolControl[];
}

function textControls(): DocumentToolControl[] {
  return [
    {
      kind: 'button',
      id: 'ink.tool.text',
      group: 'draw',
      label: 'Text',
      shortLabel: 'Text',
      semanticRole: 'surface.insert.text',
      active: true,
      activationRole: 'tool',
    },
  ] as unknown as DocumentToolControl[];
}

// ---------------------------------------------------------------------------
// Composition registry lifecycle: every registration API
// ---------------------------------------------------------------------------

describe('composition lifecycle invariant', () => {
  it('registerCategory: activate -> 1 / dispose -> 0 / reactivate -> 1', () => {
    const created = createToolbarCompositionRegistry();
    try {
      expect(created.registry.snapshot().categories).toHaveLength(0);
      const handle = created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
        groupId: 'surface.write',
      });
      expect(created.registry.snapshot().categories).toHaveLength(1);
      handle.dispose();
      expect(created.registry.snapshot().categories).toHaveLength(0);
      const revived = created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
        groupId: 'surface.write',
      });
      expect(created.registry.snapshot().categories).toHaveLength(1);
      // No leak: second dispose is idempotent, snapshot stays at one until disposed.
      revived.dispose();
      revived.dispose();
      expect(created.registry.snapshot().categories).toHaveLength(0);
    } finally {
      created.dispose();
    }
  });

  it('registerItem: activate -> 1 / dispose -> 0 / reactivate -> 1', () => {
    const created = createToolbarCompositionRegistry();
    try {
      const handle = created.registry.registerItem({
        id: 'surface.write.ball',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        slotId: 'surface.slot.pen.ball',
      });
      expect(created.registry.snapshot().items).toHaveLength(1);
      handle.dispose();
      expect(created.registry.snapshot().items).toHaveLength(0);
      const revived = created.registry.registerItem({
        id: 'surface.write.ball',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        slotId: 'surface.slot.pen.ball',
      });
      expect(created.registry.snapshot().items).toHaveLength(1);
      revived.dispose();
      expect(created.registry.snapshot().items).toHaveLength(0);
    } finally {
      created.dispose();
    }
  });

  it('registerSettings: activate -> 1 / dispose -> 0 / reactivate -> 1', () => {
    const created = createToolbarCompositionRegistry();
    try {
      const handle = created.registry.registerSettings({
        id: 'test.settings.color',
        targetSemanticRole: 'surface.pen.ball',
        semanticRole: 'surface.settings.color',
      });
      expect(created.registry.snapshot().settings).toHaveLength(1);
      handle.dispose();
      expect(created.registry.snapshot().settings ?? []).toHaveLength(0);
      const revived = created.registry.registerSettings({
        id: 'test.settings.color',
        targetSemanticRole: 'surface.pen.ball',
        semanticRole: 'surface.settings.color',
      });
      expect(created.registry.snapshot().settings).toHaveLength(1);
      revived.dispose();
      expect(created.registry.snapshot().settings ?? []).toHaveLength(0);
    } finally {
      created.dispose();
    }
  });

  it('registerKindExtension: activate -> 1 / dispose -> 0 / reactivate -> 1', () => {
    const created = createToolbarCompositionRegistry();
    try {
      const handle = created.registry.registerKindExtension({
        id: 'surface.ink',
        kindIds: ['froglight.ink'],
        familyIds: ['surface'],
      });
      expect(created.registry.snapshot().extensions).toHaveLength(1);
      handle.dispose();
      expect(created.registry.snapshot().extensions).toHaveLength(0);
      const revived = created.registry.registerKindExtension({
        id: 'surface.ink',
        kindIds: ['froglight.ink'],
        familyIds: ['surface'],
      });
      expect(created.registry.snapshot().extensions).toHaveLength(1);
      revived.dispose();
      expect(created.registry.snapshot().extensions).toHaveLength(0);
    } finally {
      created.dispose();
    }
  });

  it('onDidChange: notify on register/dispose, silence after dispose, reactivate notifies', () => {
    const created = createToolbarCompositionRegistry();
    try {
      let calls = 0;
      const sub = created.registry.onDidChange(() => {
        calls += 1;
      });
      expect(calls).toBe(0);
      const handle = created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
      });
      expect(calls).toBe(1);
      handle.dispose();
      expect(calls).toBe(2);
      sub.dispose();
      created.registry.registerCategory({
        id: 'surface.erase',
        familyId: 'surface',
        label: 'Erase',
        icon: 'eraser',
      });
      // Disposed listener stays silent: no leaked notification.
      expect(calls).toBe(2);
      // Reactivate: a fresh listener observes exactly one notification.
      let revivedCalls = 0;
      const revived = created.registry.onDidChange(() => {
        revivedCalls += 1;
      });
      created.registry.registerItem({
        id: 'surface.write.ball',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
      });
      expect(revivedCalls).toBe(1);
      revived.dispose();
    } finally {
      created.dispose();
    }
  });

  it('same-id shadow restores previous binding with grouping metadata intact', () => {
    const created = createToolbarCompositionRegistry();
    try {
      const first = created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
        groupId: 'surface.write',
      });
      const shadow = created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Draw',
        icon: 'pen',
        groupId: 'surface.write-shadow',
      });
      expect(created.registry.snapshot().categories[0]?.label).toBe('Draw');
      expect(created.registry.snapshot().categories[0]?.groupId).toBe(
        'surface.write-shadow',
      );
      shadow.dispose();
      expect(created.registry.snapshot().categories[0]?.label).toBe('Write');
      expect(created.registry.snapshot().categories[0]?.groupId).toBe(
        'surface.write',
      );
      first.dispose();
      expect(created.registry.snapshot().categories).toHaveLength(0);

      const itemFirst = created.registry.registerItem({
        id: 'surface.write.ball',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        slotId: 'surface.slot.pen.ball',
      });
      const itemShadow = created.registry.registerItem({
        id: 'surface.write.ball',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        slotId: 'surface.slot.pen.override',
      });
      expect(created.registry.snapshot().items[0]?.slotId).toBe(
        'surface.slot.pen.override',
      );
      itemShadow.dispose();
      expect(created.registry.snapshot().items[0]?.slotId).toBe(
        'surface.slot.pen.ball',
      );
      itemFirst.dispose();
      expect(created.registry.snapshot().items).toHaveLength(0);
    } finally {
      created.dispose();
    }
  });

  it('toolbarCompositionPlugin owns registrations as reversible runtime effects', async () => {
    const runtime = new Runtime();
    try {
      await runtime.registerSlot({
        id: 'toolbar-composition',
        plugin: toolbarCompositionPlugin,
        config: {
          categories: [
            {
              id: 'surface.write',
              familyId: 'surface',
              label: 'Write',
              icon: 'pen',
              groupId: 'surface.write',
            },
          ],
          items: [
            {
              id: 'surface.write.ball',
              categoryId: 'surface.write',
              semanticRole: 'surface.pen.ball',
              slotId: 'surface.slot.pen.ball',
            },
          ],
          extensions: [
            {
              id: 'surface.ink',
              kindIds: ['froglight.ink'],
              familyIds: ['surface'],
            },
          ],
        },
      });
      const seenRef: {
        current:
          | ReturnType<typeof createToolbarCompositionRegistry>['registry']
          | null;
      } = { current: null };
      await runtime.registerSlot({
        id: 'probe',
        plugin: definePlugin({
          id: 'test.composition-probe',
          requirements: { requires: [toolbarCompositionToken] },
          activate: (ctx) => {
            seenRef.current = ctx.require(toolbarCompositionToken);
          },
        }),
      });
      expect(seenRef.current?.snapshot().categories).toHaveLength(1);
      expect(seenRef.current?.snapshot().items).toHaveLength(1);
      await runtime.removeSlot('probe');
      await runtime.removeSlot('toolbar-composition');
      // After disposal the token has no binding: a fresh probe stays inactive.
      const after = await runtime.registerSlot({
        id: 'probe-after',
        plugin: definePlugin({
          id: 'test.composition-probe-after',
          requirements: { requires: [toolbarCompositionToken] },
          activate: (ctx) => {
            seenRef.current = ctx.require(toolbarCompositionToken);
          },
        }),
      });
      expect(after.state).toBe('inactive');
      await runtime.removeSlot('probe-after');
      // Reactivate: one registration again, no leak.
      await runtime.registerSlot({
        id: 'toolbar-composition',
        plugin: toolbarCompositionPlugin,
        config: {
          categories: [
            {
              id: 'surface.write',
              familyId: 'surface',
              label: 'Write',
              icon: 'pen',
              groupId: 'surface.write',
            },
          ],
        },
      });
      let revived: unknown = null;
      await runtime.registerSlot({
        id: 'probe-revived',
        plugin: definePlugin({
          id: 'test.composition-probe-revived',
          requirements: { requires: [toolbarCompositionToken] },
          activate: (ctx) => {
            revived = ctx.require(toolbarCompositionToken);
          },
        }),
      });
      expect(
        (revived as { snapshot(): { categories: unknown[] } }).snapshot()
          .categories,
      ).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Placement registry lifecycle (shelf/utility placements)
// ---------------------------------------------------------------------------

describe('placement lifecycle invariant', () => {
  it('register: activate -> 1 / dispose -> 0 / reactivate -> 1', () => {
    const created = createToolbarPlacementRegistry();
    try {
      const handle = created.registry.register({
        id: 'test.history',
        anchor: 'float.top-left',
        controlIds: ['shell.history.undo'],
      });
      expect(
        created.registry.placementsFor(context('froglight.ink')),
      ).toHaveLength(1);
      handle.dispose();
      expect(
        created.registry.placementsFor(context('froglight.ink')),
      ).toHaveLength(0);
      const revived = created.registry.register({
        id: 'test.history',
        anchor: 'float.top-left',
        controlIds: ['shell.history.undo'],
      });
      expect(
        created.registry.placementsFor(context('froglight.ink')),
      ).toHaveLength(1);
      revived.dispose();
      expect(
        created.registry.placementsFor(context('froglight.ink')),
      ).toHaveLength(0);
    } finally {
      created.dispose();
    }
  });

  it('same-id shadow restores the previous placement', () => {
    const created = createToolbarPlacementRegistry();
    try {
      const first = created.registry.register({
        id: 'shared',
        anchor: 'topbar-center',
        controlIds: ['a'],
      });
      const shadow = created.registry.register({
        id: 'shared',
        anchor: 'float.top-center',
        controlIds: ['b'],
      });
      expect(
        created.registry
          .placementsFor(context('froglight.ink'))
          .map((p) => p.anchor),
      ).toEqual(['float.top-center']);
      shadow.dispose();
      expect(
        created.registry
          .placementsFor(context('froglight.ink'))
          .map((p) => p.anchor),
      ).toEqual(['topbar-center']);
      first.dispose();
      expect(created.registry.placementsFor(context('froglight.ink'))).toEqual(
        [],
      );
    } finally {
      created.dispose();
    }
  });

  it('onDidChange notifies until disposed (no leaked listener)', () => {
    const created = createToolbarPlacementRegistry();
    try {
      const events: string[] = [];
      const sub = created.registry.onDidChange(() => events.push('change'));
      const handle = created.registry.register({
        id: 'a',
        anchor: 'topbar-center',
        controlIds: [],
      });
      expect(events).toEqual(['change']);
      handle.dispose();
      expect(events).toEqual(['change', 'change']);
      sub.dispose();
      created.registry.register({
        id: 'b',
        anchor: 'topbar-center',
        controlIds: [],
      });
      expect(events).toEqual(['change', 'change']);
    } finally {
      created.dispose();
    }
  });

  it('default utility placements register/dispose/reactivate as one unit each', () => {
    const created = createToolbarPlacementRegistry();
    try {
      const placements = defaultToolbarPlacements();
      expect(placements.length).toBeGreaterThan(0);
      const handles = placements.map((placement) =>
        created.registry.register(placement),
      );
      const pdf = created.registry.placementsFor(context('froglight.pdf'));
      expect(
        pdf.some((p) => p.id === 'froglight.toolbar-placement.pdf.pages'),
      ).toBe(true);
      expect(
        pdf.some((p) => p.id === 'froglight.toolbar-placement.history'),
      ).toBe(true);
      for (const handle of handles) handle.dispose();
      expect(created.registry.placementsFor(context('froglight.pdf'))).toEqual(
        [],
      );
      const revived = placements.map((placement) =>
        created.registry.register(placement),
      );
      expect(
        created.registry.placementsFor(context('froglight.pdf')),
      ).toHaveLength(pdf.length);
      for (const handle of revived) handle.dispose();
      expect(created.registry.placementsFor(context('froglight.pdf'))).toEqual(
        [],
      );
    } finally {
      created.dispose();
    }
  });

  it('documentToolbarPlacementPlugin owns placements as reversible effects', async () => {
    const runtime = new Runtime();
    try {
      await runtime.registerSlot({
        id: 'document-toolbar-placement',
        plugin: documentToolbarPlacementPlugin,
        config: {
          placements: [
            {
              id: 'test.utility',
              anchor: 'float.bottom-center',
              controlIds: ['pdf.previous'],
            },
          ],
        },
      });
      const seenPlacementRef: {
        current:
          | ReturnType<typeof createToolbarPlacementRegistry>['registry']
          | null;
      } = { current: null };
      await runtime.registerSlot({
        id: 'placement-probe',
        plugin: definePlugin({
          id: 'test.placement-probe',
          requirements: { requires: [documentToolbarPlacementToken] },
          activate: (ctx) => {
            seenPlacementRef.current = ctx.require(
              documentToolbarPlacementToken,
            );
          },
        }),
      });
      expect(
        seenPlacementRef.current?.placementsFor(context('froglight.pdf')),
      ).toHaveLength(1);
      await runtime.removeSlot('placement-probe');
      await runtime.removeSlot('document-toolbar-placement');
      const after = await runtime.registerSlot({
        id: 'placement-probe-after',
        plugin: definePlugin({
          id: 'test.placement-probe-after',
          requirements: { requires: [documentToolbarPlacementToken] },
          activate: (ctx) => {
            seenPlacementRef.current = ctx.require(
              documentToolbarPlacementToken,
            );
          },
        }),
      });
      expect(after.state).toBe('inactive');
      await runtime.removeSlot('placement-probe-after');
    } finally {
      await runtime.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Document-toolbar contribution lifecycle
// ---------------------------------------------------------------------------

describe('document-toolbar contribution lifecycle invariant', () => {
  it('register: activate -> 1 / dispose -> 0 / reactivate -> 1', async () => {
    const created = createDocumentToolbarRegistry();
    try {
      const handle = created.registry.register({
        id: 'acme.tools',
        controls: () => [button('acme.cite')],
        execute: () => true,
      });
      expect(
        created.registry.controls(context('froglight.markdown')),
      ).toHaveLength(1);
      expect(
        await created.registry.execute(
          context('froglight.markdown'),
          'acme.cite',
        ),
      ).toBe(true);
      handle.dispose();
      expect(created.registry.controls(context('froglight.markdown'))).toEqual(
        [],
      );
      const revived = created.registry.register({
        id: 'acme.tools',
        controls: () => [button('acme.cite')],
        execute: () => true,
      });
      expect(
        created.registry.controls(context('froglight.markdown')),
      ).toHaveLength(1);
      revived.dispose();
      expect(created.registry.controls(context('froglight.markdown'))).toEqual(
        [],
      );
    } finally {
      created.dispose();
    }
  });

  it('same-id shadow restores the previous contribution', () => {
    const created = createDocumentToolbarRegistry();
    try {
      const first = created.registry.register({
        id: 'acme.tools',
        controls: () => [button('first')],
        execute: () => false,
      });
      const shadow = created.registry.register({
        id: 'acme.tools',
        controls: () => [button('second')],
        execute: () => false,
      });
      expect(created.registry.controls(context('any'))[0]?.id).toBe('second');
      shadow.dispose();
      expect(created.registry.controls(context('any'))[0]?.id).toBe('first');
      first.dispose();
      expect(created.registry.controls(context('any'))).toEqual([]);
    } finally {
      created.dispose();
    }
  });

  it('onDidChange notifies until disposed', () => {
    const created = createDocumentToolbarRegistry();
    try {
      let calls = 0;
      const sub = created.registry.onDidChange(() => {
        calls += 1;
      });
      const handle = created.registry.register({
        id: 'acme.tools',
        controls: () => [button('acme.cite')],
        execute: () => true,
      });
      expect(calls).toBe(1);
      handle.dispose();
      expect(calls).toBe(2);
      sub.dispose();
      created.registry.register({
        id: 'acme.other',
        controls: () => [button('acme.other')],
        execute: () => true,
      });
      expect(calls).toBe(2);
    } finally {
      created.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Customization-backed slot overrides lifecycle
// ---------------------------------------------------------------------------

describe('customization store lifecycle invariant', () => {
  it('notify -> dispose -> silence -> reactivate over the same envelope', () => {
    const settings = new InMemorySettingsService();
    const store = new ToolbarCustomizationStore({ settings });
    try {
      let notifications = 0;
      const sub = store.onChange(() => {
        notifications += 1;
      });
      store.setSlotPens(['pen-slot-1']);
      expect(notifications).toBe(1);
      expect(store.snapshot().slotPens).toEqual(['pen-slot-1']);
      sub.dispose();
      store.dispose();
      // After dispose: silenced, no state change, no settings write.
      const rawBefore = settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY);
      store.setSlotPens(['pen-slot-2']);
      expect(notifications).toBe(1);
      expect(store.snapshot().slotPens).toEqual(['pen-slot-1']);
      store.reset();
      expect(settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY)).toBe(rawBefore);
      // Reactivate: fresh store over the same envelope restores exactly once.
      const revived = new ToolbarCustomizationStore({ settings });
      try {
        expect(revived.snapshot().slotPens).toEqual(['pen-slot-1']);
        revived.setSlotPens(['pen-slot-2']);
        expect(revived.snapshot().slotPens).toEqual(['pen-slot-2']);
      } finally {
        revived.dispose();
      }
    } finally {
      store.dispose();
    }
  });

  it('slot overrides re-sort after reactivate; unknown ids stay dormant-safe', () => {
    const settings = new InMemorySettingsService();
    const store = new ToolbarCustomizationStore({ settings });
    try {
      store.setSlotPens(['pen-slot-2', 'missing.pen', 'pen-slot-1']);
      expect(store.snapshot().slotPens).toEqual([
        'pen-slot-2',
        'missing.pen',
        'pen-slot-1',
      ]);
      const reloaded = new ToolbarCustomizationStore({ settings });
      try {
        expect(reloaded.snapshot()).toEqual(store.snapshot());
        expect(reloaded.overrides().slotPens).toEqual([
          'pen-slot-2',
          'missing.pen',
          'pen-slot-1',
        ]);
      } finally {
        reloaded.dispose();
      }
      store.reset();
      expect(store.snapshot().slotPens).toBeUndefined();
      expect(store.overrides()).toEqual({});
    } finally {
      store.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Family contributions lifecycle (default composition per family)
// ---------------------------------------------------------------------------

describe('family contributions lifecycle', () => {
  it('default categories/items/extensions install, dispose one family, reactivate restores', () => {
    const created = createToolbarCompositionRegistry();
    try {
      const defaults = defaultToolbarComposition();
      const categoryHandles = defaults.categories.map((entry) =>
        created.registry.registerCategory(entry),
      );
      const itemHandles = defaults.items.map((entry) =>
        created.registry.registerItem(entry),
      );
      const extensionHandles = new Map<string, { dispose(): void }>();
      for (const entry of defaults.extensions) {
        extensionHandles.set(
          entry.id,
          created.registry.registerKindExtension(entry),
        );
      }
      expect(created.registry.snapshot().categories.length).toBeGreaterThan(0);
      expect(created.registry.snapshot().items.length).toBeGreaterThan(0);
      // Dispose the Notebook PDF insertion contribution; page management
      // remains outside the toolbar graph.
      extensionHandles.get('surface.notebook')?.dispose();
      const notebookControls: DocumentToolControl[] = [
        button('notebook.insert-pdf-before', 'notebook.insert.pdf.before'),
      ];
      const dormant = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.notebook',
        controls: notebookControls,
      });
      expect(
        dormant.categories.some((entry) => entry.id === 'surface.insert'),
      ).toBe(false);
      // No leaked notebook category; surface grammar still resolves for ink.
      const inkStill = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.ink',
        controls: [button('ink.pen', 'surface.pen.ball')],
      });
      expect(
        inkStill.categories.some((entry) => entry.id === 'surface.write'),
      ).toBe(true);
      // Reactivate the same family: exactly one registration again.
      const notebookExtension = defaults.extensions.find(
        (entry) => entry.id === 'surface.notebook',
      );
      if (notebookExtension === undefined)
        throw new Error('missing surface.notebook extension');
      const revived = created.registry.registerKindExtension(notebookExtension);
      const restored = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.notebook',
        controls: notebookControls,
      });
      expect(
        restored.categories.some((entry) => entry.id === 'surface.insert'),
      ).toBe(true);
      revived.dispose();
      expect(
        resolveToolbarComposition({
          snapshot: created.registry.snapshot(),
          kindId: 'froglight.notebook',
          controls: notebookControls,
        }).categories.some((entry) => entry.id === 'surface.insert'),
      ).toBe(false);
      // Full dispose leaves zero registrations (no leak).
      for (const handle of categoryHandles) handle.dispose();
      for (const handle of itemHandles) handle.dispose();
      for (const [id, handle] of extensionHandles) {
        if (id !== 'surface.notebook') handle.dispose();
      }
      expect(created.registry.snapshot().categories).toEqual([]);
      expect(created.registry.snapshot().items).toEqual([]);
      expect(created.registry.snapshot().extensions).toEqual([]);
    } finally {
      created.dispose();
    }
  });

  it('surface families share the grouped grammar; whiteboard card stays additions-only', () => {
    const created = createToolbarCompositionRegistry();
    try {
      installDefaultComposition(created.registry);
      const inkPen = button('ink.pen', 'surface.pen.ball');
      const inkGraph = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.ink',
        controls: [inkPen],
      });
      expect(inkGraph.diagnostics).toEqual([]);
      expect(
        inkGraph.categories.some((entry) => entry.id === 'surface.write'),
      ).toBe(true);
      // Whiteboard card is additions-only: ink never sees it, whiteboard does
      // only when the provider emits it.
      expect(
        inkGraph.categories
          .flatMap((entry) => entry.items)
          .some((item) => item.semanticRole === 'surface.insert.card'),
      ).toBe(false);
    } finally {
      created.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Community lifecycle (grouping-era, owner-scoped reversible effects)
// ---------------------------------------------------------------------------

describe('community lifecycle invariant', () => {
  function communityHarness() {
    const composition = createToolbarCompositionRegistry();
    const controls = createDocumentToolbarRegistry();
    composition.registry.registerCategory({
      id: 'surface.shapes',
      familyId: 'surface',
      label: 'Shapes',
      icon: 'shapes',
      groupId: 'surface.insert',
    });
    composition.registry.registerKindExtension({
      id: 'surface-kind',
      kindIds: ['froglight.ink'],
      familyIds: ['surface'],
    });
    const broker = { execute: vi.fn(() => true) };
    return { composition, controls, broker };
  }

  it('activate -> 1 / dispose -> 0 / reactivate -> 1 with structure+execution together', async () => {
    const h = communityHarness();
    try {
      const ctx = context('froglight.ink');
      const handle = registerCommunityToolbarContribution({
        pluginId: 'example.diagram',
        manifest: {
          id: 'diamond',
          targetCategoryId: 'surface.shapes',
          label: 'Decision diamond',
          icon: 'shapes',
          commandId: 'insert-diamond',
        },
        composition: h.composition.registry,
        controls: h.controls.registry,
        broker: h.broker,
      });
      expect(
        h.composition.registry
          .snapshot()
          .items.filter((item) =>
            item.id.startsWith('community.example.diagram.'),
          ),
      ).toHaveLength(1);
      expect(h.controls.registry.controls(ctx)).toHaveLength(1);
      expect(
        await h.controls.registry.execute(
          ctx,
          'community.example.diagram.diamond.command',
        ),
      ).toBe(true);
      handle.dispose();
      // Both registrations disposed together: no orphan structure or execution.
      expect(
        h.composition.registry
          .snapshot()
          .items.filter((item) => item.id.startsWith('community.')),
      ).toHaveLength(0);
      expect(h.controls.registry.controls(ctx)).toEqual([]);
      const revived = registerCommunityToolbarContribution({
        pluginId: 'example.diagram',
        manifest: {
          id: 'diamond',
          targetCategoryId: 'surface.shapes',
          label: 'Decision diamond',
          icon: 'shapes',
          commandId: 'insert-diamond',
        },
        composition: h.composition.registry,
        controls: h.controls.registry,
        broker: h.broker,
      });
      expect(
        h.composition.registry
          .snapshot()
          .items.filter((item) =>
            item.id.startsWith('community.example.diagram.'),
          ),
      ).toHaveLength(1);
      expect(h.controls.registry.controls(ctx)).toHaveLength(1);
      revived.dispose();
      expect(h.controls.registry.controls(ctx)).toEqual([]);
    } finally {
      h.composition.dispose();
      h.controls.dispose();
    }
  });

  it('dormant category stays dormant and revives without orphan', () => {
    const composition = createToolbarCompositionRegistry();
    const controls = createDocumentToolbarRegistry();
    try {
      composition.registry.registerKindExtension({
        id: 'surface-kind',
        kindIds: ['froglight.ink'],
        familyIds: ['surface'],
      });
      const handle = registerCommunityToolbarContribution({
        pluginId: 'example.diagram',
        manifest: {
          id: 'diamond',
          targetCategoryId: 'surface.shapes',
          label: 'Decision diamond',
          commandId: 'insert-diamond',
        },
        composition: composition.registry,
        controls: controls.registry,
        broker: { execute: () => false },
      });
      const pool = controls.registry.controls(context('froglight.ink'));
      expect(
        resolveToolbarComposition({
          snapshot: composition.registry.snapshot(),
          kindId: 'froglight.ink',
          controls: pool,
        }).unresolved,
      ).toContain('community.example.diagram.diamond.item');
      const category = composition.registry.registerCategory({
        id: 'surface.shapes',
        familyId: 'surface',
        label: 'Shapes',
        icon: 'shapes',
      });
      expect(
        resolveToolbarComposition({
          snapshot: composition.registry.snapshot(),
          kindId: 'froglight.ink',
          controls: pool,
        }).categories[0]?.items[0]?.control.id,
      ).toBe('community.example.diagram.diamond.command');
      category.dispose();
      handle.dispose();
      expect(
        composition.registry
          .snapshot()
          .items.filter((item) => item.id.startsWith('community.')),
      ).toHaveLength(0);
    } finally {
      composition.dispose();
      controls.dispose();
    }
  });

  it('host bridge registers through the validated DTO and disposes both sides', () => {
    const composition = createToolbarCompositionRegistry();
    const controls = createDocumentToolbarRegistry();
    try {
      composition.registry.registerCategory({
        id: 'surface.shapes',
        familyId: 'surface',
        label: 'Shapes',
        icon: 'shapes',
      });
      composition.registry.registerKindExtension({
        id: 'surface-kind',
        kindIds: ['froglight.ink'],
        familyIds: ['surface'],
      });
      const host = createCommunityToolbarHost({
        composition: composition.registry,
        controls: controls.registry,
        commands: {
          execute: () => Promise.resolve({ ok: true }),
        } as never,
      });
      const handle = host.registerToolbar('example.diagram', {
        id: 'tool',
        targetCategoryId: 'surface.shapes',
        label: 'Tool',
        commandId: 'run',
      });
      expect(
        composition.registry
          .snapshot()
          .items.filter((item) => item.id.startsWith('community.')),
      ).toHaveLength(1);
      expect(controls.registry.controls(context('froglight.ink'))).toHaveLength(
        1,
      );
      handle.dispose();
      expect(
        composition.registry
          .snapshot()
          .items.filter((item) => item.id.startsWith('community.')),
      ).toHaveLength(0);
      expect(controls.registry.controls(context('froglight.ink'))).toEqual([]);
    } finally {
      composition.dispose();
      controls.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Text-pair allowlist vs all-other-duplicates diagnostic
// ---------------------------------------------------------------------------

describe('duplicate diagnostics: Text allowlist vs all other duplicates', () => {
  const familyExtension = {
    id: 'surface.ink',
    kindIds: ['froglight.ink'],
    familyIds: ['surface'],
  };

  function textSnapshot() {
    return {
      categories: [
        {
          id: 'surface.insert',
          familyId: 'surface',
          label: 'Insert',
          icon: 'plus',
          order: 50,
          groupId: 'surface.insert',
        },
        {
          id: 'surface.text',
          familyId: 'surface',
          label: 'Text',
          icon: 'type',
          order: 60,
          groupId: 'surface.text',
        },
      ],
      items: [
        {
          id: SURFACE_TEXT_INSERT_ITEM_ID,
          categoryId: 'surface.insert',
          semanticRole: SURFACE_TEXT_CREATION_ROLE,
          order: 10,
        },
        {
          id: SURFACE_TEXT_CREATE_ITEM_ID,
          categoryId: 'surface.text',
          semanticRole: SURFACE_TEXT_CREATION_ROLE,
          order: 0,
        },
      ],
      extensions: [familyExtension],
    };
  }

  it('Text creation pair is the sole authorized dual presenter (no diagnostic)', () => {
    const controls = [
      {
        kind: 'button',
        id: 'ink.text',
        group: 'draw',
        label: 'Text',
        semanticRole: SURFACE_TEXT_CREATION_ROLE,
      },
    ] as const;
    const graph = resolveToolbarComposition({
      snapshot: textSnapshot(),
      kindId: 'froglight.ink',
      controls,
    });
    expect(
      graph.diagnostics.filter((entry) =>
        entry.startsWith('duplicate presenter'),
      ),
    ).toEqual([]);
  });

  it('any other duplicate presenter reports (never silent)', () => {
    const controls = [
      {
        kind: 'button',
        id: 'ink.text',
        group: 'draw',
        label: 'Text',
        semanticRole: SURFACE_TEXT_CREATION_ROLE,
      },
    ] as const;
    const duplicated = resolveToolbarComposition({
      snapshot: {
        ...textSnapshot(),
        items: [
          ...textSnapshot().items,
          {
            id: 'surface.insert.text.copy',
            categoryId: 'surface.insert',
            semanticRole: SURFACE_TEXT_CREATION_ROLE,
            order: 20,
          },
        ],
      },
      kindId: 'froglight.ink',
      controls,
    });
    expect(duplicated.diagnostics).toContain(
      `duplicate presenter for semantic role '${SURFACE_TEXT_CREATION_ROLE}' ` +
        `(${SURFACE_TEXT_INSERT_ITEM_ID}, surface.insert.text.copy, ${SURFACE_TEXT_CREATE_ITEM_ID})`,
    );
    // A non-Text duplicate also reports.
    const other = resolveToolbarComposition({
      snapshot: {
        categories: [
          {
            id: 'surface.write',
            familyId: 'surface',
            label: 'Write',
            icon: 'pen',
          },
        ],
        items: [
          {
            id: 'surface.write.a',
            categoryId: 'surface.write',
            semanticRole: 'surface.pen.ball',
          },
          {
            id: 'surface.write.b',
            categoryId: 'surface.write',
            semanticRole: 'surface.pen.ball',
          },
        ],
        extensions: [familyExtension],
      },
      kindId: 'froglight.ink',
      controls: [
        {
          kind: 'button',
          id: 'ink.pen',
          group: 'draw',
          label: 'Pen',
          semanticRole: 'surface.pen.ball',
        },
      ] as const,
    });
    expect(
      other.diagnostics.filter((entry) =>
        entry.startsWith('duplicate presenter'),
      ),
    ).toHaveLength(1);
  });

  it('duplicate semantic toolbar role reports (never silent)', () => {
    const composition = createToolbarCompositionRegistry();
    try {
      composition.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
      });
      composition.registry.registerItem({
        id: 'test.write.pen',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
      });
      composition.registry.registerKindExtension({
        id: 'test-ink-family',
        kindIds: ['froglight.ink'],
        familyIds: ['surface'],
      });
      const graph = resolveToolbarComposition({
        snapshot: composition.registry.snapshot(),
        kindId: 'froglight.ink',
        controls: [
          button('ink.pen', 'surface.pen.ball'),
          button('ink.pen.clone', 'surface.pen.ball'),
        ],
      });
      expect(graph.diagnostics.join('\n')).toContain(
        "duplicate semantic toolbar role 'surface.pen.ball'",
      );
    } finally {
      composition.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Shelf/utility cross-layer lifecycle incl. diagnostic
// ---------------------------------------------------------------------------

describe('shelf/utility cross-layer lifecycle incl. diagnostic', () => {
  function harness() {
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    for (const placement of defaultToolbarPlacements()) {
      placements.registry.register(placement);
    }
    const composition = createToolbarCompositionRegistry();
    installDefaultComposition(composition.registry);
    return { contributions, placements, composition };
  }

  function crossLayerOf(
    input: Parameters<typeof computeUnifiedToolbarModel>[0],
  ): readonly string[] {
    return computeUnifiedToolbarModel(input).layout.diagnostics.filter(
      (entry) => entry.includes('in composition shelf'),
    );
  }

  it('cross-layer diagnostic appears, disposes to zero, reactivates to one', () => {
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    installDefaultComposition(composition.registry);
    // Track handles so dispose/reactivate targets the live registration
    // (never the whole registry, which would orphan the harness).
    const handles = new Map<string, { dispose(): void }>();
    for (const placement of defaultToolbarPlacements()) {
      handles.set(placement.id, placements.registry.register(placement));
    }
    try {
      const port = {
        onDidChange: () => ({ dispose: () => undefined }),
        execEditorCommand: () => false,
        canExecEditorCommand: () => false,
        editorToolSnapshot: () => ({
          context: 'PDF source',
          controls: pdfControls(),
        }),
        executeEditorTool: () => true,
      } as unknown as WorkbenchEditorToolsPort;
      const input = {
        tools: port,
        contributions: contributions.registry,
        placements: placements.registry,
        composition: composition.registry,
        pane: 'pane-1',
        documentId: 'doc-1',
        kindId: 'froglight.pdf',
      };
      const before = crossLayerOf(input);
      expect(
        before.filter((entry) => entry.includes("'pdf.previous'")),
      ).toHaveLength(1);
      expect(
        before.filter((entry) => entry.includes("'pdf.next'")),
      ).toHaveLength(1);
      // Dispose the geometric pages placement: the cross-layer duplicate
      // must disappear (no leaked diagnostic), shelf ownership returns.
      handles.get('froglight.toolbar-placement.pdf.pages')?.dispose();
      const withoutPages = crossLayerOf(input);
      expect(
        withoutPages.filter((entry) => entry.includes("'pdf.previous'")),
      ).toHaveLength(0);
      expect(
        withoutPages.filter((entry) => entry.includes("'pdf.next'")),
      ).toHaveLength(0);
      // Reactivate: diagnostic returns exactly once per control.
      const pages = defaultToolbarPlacements().find(
        (p) => p.id === 'froglight.toolbar-placement.pdf.pages',
      );
      if (pages === undefined) throw new Error('missing pdf.pages placement');
      handles.set(pages.id, placements.registry.register(pages));
      const after = crossLayerOf(input);
      expect(
        after.filter((entry) => entry.includes("'pdf.previous'")),
      ).toHaveLength(1);
      expect(
        after.filter((entry) => entry.includes("'pdf.next'")),
      ).toHaveLength(1);
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  it('notebook management remains outside the toolbar graph', () => {
    const h = harness();
    try {
      const port = {
        onDidChange: () => ({ dispose: () => undefined }),
        execEditorCommand: () => false,
        canExecEditorCommand: () => false,
        editorToolSnapshot: () => ({
          context: 'Notebook',
          controls: [
            button('notebook.previous', 'notebook.page.previous'),
            button('notebook.next', 'notebook.page.next'),
            button('notebook.add', 'notebook.page.add'),
            button('notebook.overview', 'notebook.page.overview'),
          ],
        }),
        executeEditorTool: () => true,
      } as unknown as WorkbenchEditorToolsPort;
      const computed = computeUnifiedToolbarModel({
        tools: port,
        contributions: h.contributions.registry,
        placements: h.placements.registry,
        composition: h.composition.registry,
        pane: 'pane-1',
        documentId: 'doc-1',
        kindId: 'froglight.notebook',
      });
      const diagnostics = computed.layout.diagnostics.filter((entry) =>
        entry.includes('in composition shelf'),
      );
      // Shelf-only: no geometric claim, no cross-layer diagnostic.
      expect(
        diagnostics.some((entry) => entry.includes("'notebook.add'")),
      ).toBe(false);
      expect(
        diagnostics.some((entry) => entry.includes("'notebook.overview'")),
      ).toBe(false);
      // The right sidebar projects those provider controls instead.
      const pages = computed.compositionGraph?.categories.find(
        (category) => category.id === 'notebook.pages',
      );
      expect(
        pages?.items.map((item) => item.control.id).sort(),
      ).toBeUndefined();
    } finally {
      h.contributions.dispose();
      h.placements.dispose();
      h.composition.dispose();
    }
  });

  it('Text creation alias never hides and never reports cross-layer', () => {
    const h = harness();
    try {
      const port = toolsPortFor(textControls());
      const computed = computeUnifiedToolbarModel({
        tools: port,
        contributions: h.contributions.registry,
        placements: h.placements.registry,
        composition: h.composition.registry,
        pane: 'pane-1',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      });
      expect(
        computed.layout.diagnostics.filter((entry) =>
          entry.includes('ink.tool.text'),
        ),
      ).toEqual([]);
      expect(
        computed.compositionGraph?.categories.some(
          (category) => category.id === 'surface.text',
        ),
      ).toBe(true);
    } finally {
      h.contributions.dispose();
      h.placements.dispose();
      h.composition.dispose();
    }
  });

  it('composition shelf + geometric islands stay disjoint by control id (single owner)', () => {
    const h = harness();
    try {
      const port = {
        onDidChange: () => ({ dispose: () => undefined }),
        execEditorCommand: () => false,
        canExecEditorCommand: () => false,
        editorToolSnapshot: () => ({
          context: 'PDF source',
          controls: pdfControls(),
        }),
        executeEditorTool: () => true,
      } as unknown as WorkbenchEditorToolsPort;
      const computed = computeUnifiedToolbarModel({
        tools: port,
        contributions: h.contributions.registry,
        placements: h.placements.registry,
        composition: h.composition.registry,
        pane: 'pane-1',
        documentId: 'doc-1',
        kindId: 'froglight.pdf',
      });
      // Every cross-layer diagnostic names a control claimed geometrically;
      // the Text alias is the sole exemption (pinned above).
      for (const entry of computed.layout.diagnostics.filter((d) =>
        d.includes('in composition shelf'),
      )) {
        expect(entry).toMatch(
          /duplicate toolbar control '.+' in composition shelf '.+' \(already owned by geometric placement '.+'\)/,
        );
      }
      // Composition graph itself stays diagnostic-clean for PDF (no duplicate
      // presenter): the cross-layer channel is the only reporter here.
      expect(
        (computed.compositionGraph?.diagnostics ?? []).filter((d) =>
          d.startsWith('duplicate presenter'),
        ),
      ).toEqual([]);
    } finally {
      h.contributions.dispose();
      h.placements.dispose();
      h.composition.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Provider-swap multi-level cascade: new fibers, no dangling, no live swap
// ---------------------------------------------------------------------------

describe('provider-swap multi-level cascade', () => {
  it('disposal creates new fibers after requirements restored (no live-object swap)', async () => {
    const tokenA = createServiceToken<{ readonly label: string }>(
      't017.service.a',
    );
    const tokenB = createServiceToken<{ readonly label: string }>(
      't017.service.b',
    );
    const tokenC = createServiceToken<{ readonly label: string }>(
      't017.service.c',
    );
    const runtime = new Runtime();
    const log: string[] = [];
    // Provider A owns a composition registry instance as its capability.
    // Consumers resolve it and register toolbar structure as owned effects,
    // so a provider swap must dispose those registrations and recreate them
    // on fresh fibers (never mutate the live object underneath consumers).
    let compositionA = createToolbarCompositionRegistry();
    const makeProvider = (label: string) =>
      definePlugin({
        id: 't017.provider-a',
        activate: (ctx) => {
          log.push(`activate:provider-a:${label}`);
          compositionA = createToolbarCompositionRegistry();
          const current = compositionA;
          current.registry.registerCategory({
            id: 'surface.write',
            familyId: 'surface',
            label: 'Write',
            icon: 'pen',
            groupId: 'surface.write',
          });
          ctx.provide(tokenA, { label });
          ctx.effect(() => () => {
            log.push(`dispose:provider-a:${label}`);
            current.dispose();
          });
          ctx.on('t017.ping', () => undefined);
        },
      });
    const consumerB = definePlugin({
      id: 't017.consumer-b',
      requirements: { requires: [tokenA] },
      activate: (ctx) => {
        log.push('activate:consumer-b');
        const a = ctx.require(tokenA);
        const item = { label: `consumer-b(${a.label})` };
        ctx.provide(tokenB, item);
        // Effect-owned toolbar structure: must vanish with the fiber.
        const composition = ctx.require(tokenA);
        void composition;
        ctx.effect(() => () => {
          log.push('dispose:consumer-b');
        });
        ctx.on('t017.ping', () => undefined);
      },
    });
    const consumerC = definePlugin({
      id: 't017.consumer-c',
      requirements: { requires: [tokenB] },
      activate: (ctx) => {
        log.push('activate:consumer-c');
        const b = ctx.require(tokenB);
        ctx.provide(tokenC, { label: `consumer-c(${b.label})` });
        ctx.effect(() => () => {
          log.push('dispose:consumer-c');
        });
      },
    });
    const leafD = definePlugin({
      id: 't017.leaf-d',
      requirements: { requires: [tokenC] },
      activate: (ctx) => {
        log.push('activate:leaf-d');
        const c = ctx.require(tokenC);
        void c;
        ctx.effect(() => () => {
          log.push('dispose:leaf-d');
        });
      },
    });

    await runtime.registerSlot({ id: 'provider-a', plugin: makeProvider('a') });
    await runtime.registerSlot({ id: 'consumer-b', plugin: consumerB });
    await runtime.registerSlot({ id: 'consumer-c', plugin: consumerC });
    await runtime.registerSlot({ id: 'leaf-d', plugin: leafD });

    let inspection = runtime.inspect();
    expect(inspection.slots.map((s) => s.state)).toEqual([
      'active',
      'active',
      'active',
      'active',
    ]);
    const oldFiberIds = new Set(inspection.fibers.map((f) => f.id));
    expect(oldFiberIds.size).toBe(4);
    const steadyEffects = inspection.counts.effects;
    const steadySubscriptions = inspection.counts.subscriptions;
    const compositionBefore = compositionA.registry;
    expect(compositionBefore.snapshot().categories).toHaveLength(1);

    await runtime.removeSlot('provider-a');
    inspection = runtime.inspect();
    // Chain collapsed: no active fiber, no binding, no subscription, no effect.
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.subscriptions).toBe(0);
    expect(inspection.counts.effects).toBe(0);
    expect(inspection.slots.every((s) => s.state === 'inactive')).toBe(true);

    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('a2'),
    });
    inspection = runtime.inspect();
    expect(inspection.slots.map((s) => s.state)).toEqual([
      'active',
      'active',
      'active',
      'active',
    ]);
    // Every fiber is fresh: no old fiber survived (no live-object swap).
    const newFiberIds = new Set(inspection.fibers.map((f) => f.id));
    expect(newFiberIds.size).toBe(4);
    for (const id of oldFiberIds) expect(newFiberIds.has(id)).toBe(false);
    // Exactly one binding per token, replacement capability resolved downstream.
    const bindingA = inspection.bindings.find((b) => b.token.id === tokenA.id);
    const bindingB = inspection.bindings.find((b) => b.token.id === tokenB.id);
    const bindingC = inspection.bindings.find((b) => b.token.id === tokenC.id);
    expect((bindingA?.implementation as { label: string }).label).toBe('a2');
    expect((bindingB?.implementation as { label: string }).label).toBe(
      'consumer-b(a2)',
    );
    expect((bindingC?.implementation as { label: string }).label).toBe(
      'consumer-c(consumer-b(a2))',
    );
    expect(
      inspection.bindings.filter((b) => b.token.id === tokenA.id),
    ).toHaveLength(1);
    // No dangling services/listeners/effects: counts return to steady state.
    expect(inspection.counts.effects).toBe(steadyEffects);
    expect(inspection.counts.subscriptions).toBe(steadySubscriptions);
    // The composition capability is a new object (not a mutated live one).
    expect(compositionA.registry).not.toBe(compositionBefore);
    expect(compositionA.registry.snapshot().categories).toHaveLength(1);
    // Teardown order was consumers-before-provider.
    expect(log).toEqual([
      'activate:provider-a:a',
      'activate:consumer-b',
      'activate:consumer-c',
      'activate:leaf-d',
      'dispose:leaf-d',
      'dispose:consumer-c',
      'dispose:consumer-b',
      'dispose:provider-a:a',
      'activate:provider-a:a2',
      'activate:consumer-b',
      'activate:consumer-c',
      'activate:leaf-d',
    ]);

    await runtime.dispose();
    inspection = runtime.inspect();
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.subscriptions).toBe(0);
    expect(inspection.counts.effects).toBe(0);
  });

  it('toolbar-owned effect scope disposes composition+placement together', async () => {
    const runtime = new Runtime();
    try {
      await runtime.registerSlot({
        id: 'toolbar-composition',
        plugin: toolbarCompositionPlugin,
        config: {},
      });
      await runtime.registerSlot({
        id: 'document-toolbar-placement',
        plugin: documentToolbarPlacementPlugin,
        config: {},
      });
      // The composition/placement registries stay usable through the swap:
      // removing a consumer never disturbs the provider-owned registries.
      const probe = await runtime.registerSlot({
        id: 'toolbar-consumer',
        plugin: definePlugin({
          id: 'test.toolbar-consumer',
          requirements: {
            requires: [toolbarCompositionToken, documentToolbarPlacementToken],
          },
          activate: (ctx) => {
            const composition = ctx.require(toolbarCompositionToken);
            const placements = ctx.require(documentToolbarPlacementToken);
            ctx.effect(
              () =>
                composition.registerCategory({
                  id: 't017.probe',
                  familyId: 'surface',
                  label: 'Probe',
                  icon: 'pen',
                }).dispose,
            );
            ctx.effect(
              () =>
                placements.register({
                  id: 't017.probe',
                  anchor: 'float.bottom-center',
                  controlIds: [],
                }).dispose,
            );
          },
        }),
      });
      expect(probe.state).toBe('active');
      const before = runtime.inspect();
      expect(before.counts.activeFibers).toBeGreaterThan(0);
      await runtime.removeSlot('toolbar-consumer');
      // Consumer effects disposed; provider registries retain zero probe entries.
      const inspectorRef: {
        composition:
          | ReturnType<typeof createToolbarCompositionRegistry>['registry']
          | null;
        placements:
          | ReturnType<typeof createToolbarPlacementRegistry>['registry']
          | null;
      } = { composition: null, placements: null };
      await runtime.registerSlot({
        id: 'toolbar-inspector',
        plugin: definePlugin({
          id: 'test.toolbar-inspector',
          requirements: {
            requires: [toolbarCompositionToken, documentToolbarPlacementToken],
          },
          activate: (ctx) => {
            inspectorRef.composition = ctx.require(toolbarCompositionToken);
            inspectorRef.placements = ctx.require(
              documentToolbarPlacementToken,
            );
          },
        }),
      });
      expect(
        inspectorRef.composition
          ?.snapshot()
          .categories.some(
            (c: { readonly id: string }) => c.id === 't017.probe',
          ),
      ).toBe(false);
      expect(
        inspectorRef.placements
          ?.placementsFor(context('froglight.ink'))
          .some((p: { readonly id: string }) => p.id === 't017.probe'),
      ).toBe(false);
      await runtime.removeSlot('toolbar-inspector');
    } finally {
      await runtime.dispose();
    }
  });
});
