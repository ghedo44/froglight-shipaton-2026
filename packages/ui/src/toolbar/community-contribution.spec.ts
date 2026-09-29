import { describe, expect, it, vi } from 'vitest';
import { defaultIconRegistry } from '../icons.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import {
  createToolbarCompositionRegistry,
  resolveToolbarComposition,
} from './composition-registry.js';
import {
  registerCommunityToolbarContribution,
  validateCommunityToolbarContribution,
} from './community-contribution.js';

describe('community toolbar contribution adapter', () => {
  it('validates plain manifests and brokers execution without host authority', async () => {
    const composition = createToolbarCompositionRegistry();
    const controls = createDocumentToolbarRegistry();
    const execute = vi.fn(() => true);
    const registration = registerCommunityToolbarContribution({
      pluginId: 'example.diagram',
      manifest: {
        id: 'diamond',
        targetCategoryId: 'surface.shapes',
        label: 'Decision diamond',
        icon: 'shapes',
        commandId: 'insert-diamond',
        showInSqueeze: true,
      },
      composition: composition.registry,
      controls: controls.registry,
      broker: { execute },
    });
    const context = {
      pane: 'p',
      documentId: 'd',
      kindId: 'froglight.ink',
      editor: null,
    };
    const control = controls.registry.controls(context)[0]!;
    expect(await controls.registry.execute(context, control.id)).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      'example.diagram',
      'insert-diamond',
      context,
    );
    expect(
      resolveToolbarComposition({
        snapshot: composition.registry.snapshot(),
        kindId: context.kindId,
        controls: [control],
      }).unresolved,
    ).toContain('community.example.diagram.diamond.item');
    composition.registry.registerCategory({
      id: 'surface.shapes',
      familyId: 'surface',
      label: 'Shapes',
      icon: 'shapes',
    });
    composition.registry.registerKindExtension({
      id: 'surface-kind',
      kindIds: [context.kindId],
      familyIds: ['surface'],
    });
    expect(
      resolveToolbarComposition({
        snapshot: composition.registry.snapshot(),
        kindId: context.kindId,
        controls: [control],
      }).categories[0]?.items[0]?.control.id,
    ).toBe(control.id);
    registration.dispose();
    expect(controls.registry.controls(context)).toEqual([]);
  });

  it('rejects unsafe identifiers and empty labels', () => {
    expect(
      validateCommunityToolbarContribution({
        id: '../bad',
        targetCategoryId: 'surface.shapes',
        label: '',
        commandId: 'run',
      }),
    ).toHaveLength(2);
  });

  it('accepts registry icons (including R8 pen names) and allows a missing icon', () => {
    for (const icon of ['shapes', 'fountain', 'brush', 'pencil'] as const) {
      expect(
        validateCommunityToolbarContribution({
          id: 'tool',
          targetCategoryId: 'surface.shapes',
          label: 'Tool',
          icon,
          commandId: 'run',
        }),
      ).toEqual([]);
    }
    // Missing icon stays valid: the control renders label-only, never an
    // empty <path d="">.
    expect(
      validateCommunityToolbarContribution({
        id: 'tool',
        targetCategoryId: 'surface.shapes',
        label: 'Tool',
        commandId: 'run',
      }),
    ).toEqual([]);
  });

  it('rejects regex-valid but unregistered icons and registers nothing', () => {
    const errors = validateCommunityToolbarContribution({
      id: 'tool',
      targetCategoryId: 'surface.shapes',
      label: 'Tool',
      icon: 'not-an-icon' as never,
      commandId: 'run',
    });
    expect(errors.join('; ')).toMatch(/not-an-icon.*approv|approv.*not-an-icon/i);

    const composition = createToolbarCompositionRegistry();
    const controls = createDocumentToolbarRegistry();
    try {
      const context = {
        pane: 'p',
        documentId: 'd',
        kindId: 'froglight.ink',
        editor: null,
      };
      expect(() =>
        registerCommunityToolbarContribution({
          pluginId: 'example.diagram',
          manifest: {
            id: 'tool',
            targetCategoryId: 'surface.shapes',
            label: 'Tool',
            icon: 'not-an-icon' as never,
            commandId: 'run',
          },
          composition: composition.registry,
          controls: controls.registry,
          broker: { execute: () => false },
        }),
      ).toThrow(/not-an-icon.*approv|approv.*not-an-icon/i);
      // Fail-closed: no structure or execution orphan.
      expect(
        composition.registry.snapshot().items.filter((item) =>
          item.id.startsWith('community.'),
        ),
      ).toEqual([]);
      expect(controls.registry.controls(context)).toEqual([]);
    } finally {
      composition.dispose();
      controls.dispose();
    }
  });

  it('honours live registry overrides for community icons', () => {
    const base = {
      id: 'tool',
      targetCategoryId: 'surface.shapes',
      label: 'Tool',
      commandId: 'run',
    } as const;
    expect(
      validateCommunityToolbarContribution({
        ...base,
        icon: 'community.test.glyph' as never,
      }),
    ).not.toEqual([]);
    const override = defaultIconRegistry.register(
      'community.test.glyph',
      'M4 4h16v16H4z',
    );
    try {
      expect(
        validateCommunityToolbarContribution({
          ...base,
          icon: 'community.test.glyph' as never,
        }),
      ).toEqual([]);
    } finally {
      override.dispose();
    }
    expect(
      validateCommunityToolbarContribution({
        ...base,
        icon: 'community.test.glyph' as never,
      }),
    ).not.toEqual([]);
  });
});
