/**
 * Activation semantics (remainder): exclusive editing tools vs
 * toggle/format active states.
 *
 * Proves that `Bold active` never becomes an exclusive-tool transition
 * while `Pen -> Eraser` (and external Pencil changes) reconcile the
 * Surface category through the explicit `activationRole` contract.
 * Provider-computed `active`/`mixed` is preserved; the shared UI
 * interprets it via `isExclusiveActiveToolControl`.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSurfaceDrawControls,
  isExclusiveActiveToolControl,
  SURFACE_TOOL_IDS,
  type DocumentToolControl,
  type DocumentToolSnapshot,
  type SurfaceToolbarDrawTool,
  type SurfaceToolbarHost,
} from '@froglight/foundation';
import type { ResolvedToolbarGraph } from '../toolbar/composition-registry.js';
import {
  resolveActiveToolCategoryId,
  resolveActiveToolControlId,
} from './UnifiedToolbar.js';
import { buildStylusPaletteModel } from '../stylus-palette-model.js';
import { findActiveSurfaceToolId } from '../stylus-accessory-helpers.js';
import type { OwnedToolbarControl } from '../toolbar/placement-resolver.js';

function button(
  id: string,
  extra: Record<string, unknown> = {},
): DocumentToolControl {
  return {
    kind: 'button',
    id,
    group: 'test',
    label: id,
    ...extra,
  } as DocumentToolControl;
}

function item(
  id: string,
  control: DocumentToolControl,
  semanticRole = id,
): ResolvedToolbarGraph['categories'][number]['items'][number] {
  return {
    id,
    semanticRole,
    order: 0,
    priority: 0,
    projections: ['normal'],
    control,
  };
}

function category(
  id: string,
  items: ReturnType<typeof item>[],
): ResolvedToolbarGraph['categories'][number] {
  return {
    id,
    label: id,
    icon: 'pen',
    familyId: id.startsWith('writing.') ? 'writing' : 'surface',
    order: 0,
    priority: 0,
    items,
  };
}

function graph(
  categories: ReturnType<typeof category>[],
): ResolvedToolbarGraph {
  return { familyIds: [], categories, settings: [], unresolved: [], diagnostics: [] };
}

describe('activation semantics (exclusive tool vs toggle)', () => {
  it('marks toggle-active Bold as non-exclusive while tool-active Pen counts', () => {
    const boldToggle = button('markdown.bold', {
      semanticRole: 'writing.bold',
      active: true,
      activationRole: 'toggle',
    });
    const penTool = button('ink.tool.froglight.ink.pen', {
      semanticRole: 'surface.pen.ball',
      role: 'surface-tool',
      toolRole: 'pen',
      active: true,
      activationRole: 'tool',
    });
    expect(isExclusiveActiveToolControl(boldToggle)).toBe(false);
    expect(isExclusiveActiveToolControl(penTool)).toBe(true);
  });

  it('preserves the legacy fallback for controls without activationRole', () => {
    const legacyBold = button('markdown.bold', {
      semanticRole: 'writing.bold',
      active: true,
    });
    // Documented legacy: snapshots that predate the field keep the
    // historic `active === true` behavior until providers migrate.
    expect(isExclusiveActiveToolControl(legacyBold)).toBe(true);
    expect(
      isExclusiveActiveToolControl(button('markdown.bold', {})),
    ).toBe(false);
  });

  it('does not treat Bold active (toggle) as an exclusive category transition', () => {
    const boldGraph = graph([
      category('writing.format', [
        item(
          'writing.format.bold',
          button('markdown.bold', {
            semanticRole: 'writing.bold',
            active: true,
            activationRole: 'toggle',
          }),
          'writing.bold',
        ),
      ]),
    ]);
    expect(resolveActiveToolCategoryId(boldGraph)).toBeNull();
    expect(resolveActiveToolControlId(boldGraph)).toBeNull();
  });

  it('reconciles Pen -> Eraser across Surface categories', () => {
    const penGraph = graph([
      category('surface.write', [
        item(
          'surface.write.ball',
          button('ink.tool.froglight.ink.pen', {
            semanticRole: 'surface.pen.ball',
            role: 'surface-tool',
            toolRole: 'pen',
            active: true,
            activationRole: 'tool',
          }),
          'surface.pen.ball',
        ),
      ]),
      category('surface.erase', [
        item(
          'surface.erase.tool',
          button('ink.tool.froglight.ink.eraser', {
            semanticRole: 'surface.erase',
            role: 'surface-tool',
            toolRole: 'eraser',
            activationRole: 'tool',
          }),
          'surface.erase',
        ),
      ]),
    ]);
    const eraserGraph = graph([
      category('surface.write', [
        item(
          'surface.write.ball',
          button('ink.tool.froglight.ink.pen', {
            semanticRole: 'surface.pen.ball',
            role: 'surface-tool',
            toolRole: 'pen',
            activationRole: 'tool',
          }),
          'surface.pen.ball',
        ),
      ]),
      category('surface.erase', [
        item(
          'surface.erase.tool',
          button('ink.tool.froglight.ink.eraser', {
            semanticRole: 'surface.erase',
            role: 'surface-tool',
            toolRole: 'eraser',
            active: true,
            activationRole: 'tool',
          }),
          'surface.erase',
        ),
      ]),
    ]);
    expect(resolveActiveToolCategoryId(penGraph)).toBe('surface.write');
    expect(resolveActiveToolControlId(penGraph)).toBe(
      'ink.tool.froglight.ink.pen',
    );
    expect(resolveActiveToolCategoryId(eraserGraph)).toBe('surface.erase');
    expect(resolveActiveToolControlId(eraserGraph)).toBe(
      'ink.tool.froglight.ink.eraser',
    );
    // A real tool change moves both derivations together.
    expect(resolveActiveToolCategoryId(penGraph)).not.toBe(
      resolveActiveToolCategoryId(eraserGraph),
    );
    expect(resolveActiveToolControlId(penGraph)).not.toBe(
      resolveActiveToolControlId(eraserGraph),
    );
  });

  it('follows an external Pencil change through the snapshot', () => {
    const penGraph = graph([
      category('surface.write', [
        item(
          'surface.write.ball',
          button('ink.tool.froglight.ink.pen', {
            semanticRole: 'surface.pen.ball',
            role: 'surface-tool',
            toolRole: 'pen',
            active: true,
            activationRole: 'tool',
          }),
          'surface.pen.ball',
        ),
        item(
          'surface.write.pencil',
          button('ink.tool.froglight.ink.pencil', {
            semanticRole: 'surface.pencil',
            role: 'surface-tool',
            activationRole: 'tool',
          }),
          'surface.pencil',
        ),
      ]),
    ]);
    // External provider update: Pencil becomes the active exclusive tool.
    const pencilGraph = graph([
      category('surface.write', [
        item(
          'surface.write.ball',
          button('ink.tool.froglight.ink.pen', {
            semanticRole: 'surface.pen.ball',
            role: 'surface-tool',
            toolRole: 'pen',
            activationRole: 'tool',
          }),
          'surface.pen.ball',
        ),
        item(
          'surface.write.pencil',
          button('ink.tool.froglight.ink.pencil', {
            semanticRole: 'surface.pencil',
            role: 'surface-tool',
            active: true,
            activationRole: 'tool',
          }),
          'surface.pencil',
        ),
      ]),
    ]);
    expect(resolveActiveToolControlId(penGraph)).toBe(
      'ink.tool.froglight.ink.pen',
    );
    expect(resolveActiveToolControlId(pencilGraph)).toBe(
      'ink.tool.froglight.ink.pencil',
    );
    // Same category (Write) but a new exclusive control id: the shelf
    // reconciliation observes the control change even within one category.
    expect(resolveActiveToolCategoryId(pencilGraph)).toBe('surface.write');
  });

  it('keeps palette activeToolId on exclusive tools, ignoring toggles', () => {
    const snapshot = {
      context: 'Ink canvas',
      controls: [
        button('ink.tool.froglight.ink.pen', {
          role: 'surface-tool',
          toolRole: 'pen',
          toolId: 'froglight.ink.pen',
          semanticRole: 'surface.pen.ball',
          active: true,
          activationRole: 'tool',
        }),
        button('ink.tool.froglight.ink.eraser', {
          role: 'surface-tool',
          toolRole: 'eraser',
          toolId: 'froglight.ink.eraser',
          semanticRole: 'surface.erase',
          activationRole: 'tool',
        }),
      ],
    } as const;
    const penModel = buildStylusPaletteModel(
      // Widen the readonly tuple for the builder seam.
      snapshot as unknown as Parameters<typeof buildStylusPaletteModel>[0],
    );
    expect(penModel?.activeToolId).toBe('ink.tool.froglight.ink.pen');

    // Toggle-active controls never become the palette's exclusive tool,
    // even when they ride the same snapshot.
    const toggleOnly = {
      context: 'Ink canvas',
      controls: [
        button('ink.tool.froglight.ink.pen', {
          role: 'surface-tool',
          toolRole: 'pen',
          toolId: 'froglight.ink.pen',
          semanticRole: 'surface.pen.ball',
          active: true,
          activationRole: 'toggle',
        }),
      ],
    } as const;
    const toggleModel = buildStylusPaletteModel(
      toggleOnly as unknown as Parameters<typeof buildStylusPaletteModel>[0],
    );
    expect(toggleModel?.activeToolId).toBeNull();
  });

  it('skips toggle-active controls in the surface-tool matcher', () => {
    const snapshot = {
      context: 'Ink canvas',
      controls: [
        button('ink.tool.froglight.ink.pen', {
          role: 'surface-tool',
          toolRole: 'pen',
          active: true,
          activationRole: 'toggle',
        }),
      ],
    } as unknown as Parameters<typeof findActiveSurfaceToolId>[0];
    expect(findActiveSurfaceToolId(snapshot)).toBeNull();
  });

  it('pins every production writing toggle as toggle-only; Bold-active-only resolves null everywhere', () => {
    // Production ids proved to emit `activationRole: toggle` by the
    // provider toggle specs (markdown-toggle, latex.dom, blockpage
    // editor). Here the shared UI proves a toggle-active Bold never
    // drives exclusive-tool reconciliation on any path.
    const productionToggleIds = [
      'markdown.bold',
      'markdown.italic',
      'markdown.code',
      'latex.bold',
      'latex.emphasis',
      'block.bold',
      'block.italic',
      'block.strike',
      'block.code',
    ] as const;
    for (const id of productionToggleIds) {
      const control = button(id, {
        semanticRole: 'writing.bold',
        active: true,
        activationRole: 'toggle',
      });
      expect(isExclusiveActiveToolControl(control)).toBe(false);
    }
    // Bold-active-only snapshot: no exclusive tool on any resolver.
    const boldOnly = {
      context: 'Markdown',
      controls: [
        button('markdown.bold', {
          semanticRole: 'writing.bold',
          active: true,
          activationRole: 'toggle',
        }),
      ],
    } as unknown as DocumentToolSnapshot;
    expect(findActiveSurfaceToolId(boldOnly)).toBeNull();
    // No surface tools: the palette stays inert (null model), never
    // claiming Bold as the active tool.
    expect(
      buildStylusPaletteModel(boldOnly)?.activeToolId ?? null,
    ).toBeNull();
    const boldGraph = graph([
      category('writing.format', [
        item(
          'writing.format.bold',
          button('markdown.bold', {
            semanticRole: 'writing.bold',
            active: true,
            activationRole: 'toggle',
          }),
          'writing.bold',
        ),
      ]),
    ]);
    expect(resolveActiveToolCategoryId(boldGraph)).toBeNull();
    expect(resolveActiveToolControlId(boldGraph)).toBeNull();
  });

  describe('real builder snapshots per surface family (Pen/Eraser/Pencil)', () => {
    function drawToolsFor(
      prefix: 'ink' | 'notebook' | 'whiteboard',
    ): readonly SurfaceToolbarDrawTool[] {
      // Mirrors the real family profiles: Ink/Notebook embed the full
      // engine id as the control-id suffix; Whiteboard uses short keys.
      // All three funnel through the shared surface builder, which emits
      // `activationRole: tool` for every draw control.
      if (prefix === 'whiteboard') {
        return [
          { key: 'pen', toolId: SURFACE_TOOL_IDS.pen, label: 'Pen', icon: 'pen' },
          {
            key: 'pencil',
            toolId: SURFACE_TOOL_IDS.pencil,
            label: 'Pencil',
            icon: 'pencil',
          },
          {
            key: 'eraser',
            toolId: SURFACE_TOOL_IDS.eraser,
            label: 'Eraser',
            icon: 'eraser',
          },
        ];
      }
      return [
        {
          key: SURFACE_TOOL_IDS.pen,
          toolId: SURFACE_TOOL_IDS.pen,
          label: 'Pen',
          icon: 'pen',
        },
        {
          key: SURFACE_TOOL_IDS.pencil,
          toolId: SURFACE_TOOL_IDS.pencil,
          label: 'Pencil',
          icon: 'pencil',
        },
        {
          key: SURFACE_TOOL_IDS.eraser,
          toolId: SURFACE_TOOL_IDS.eraser,
          label: 'Eraser',
          icon: 'eraser',
        },
      ];
    }

    function builderSnapshot(
      prefix: 'ink' | 'notebook' | 'whiteboard',
      activeToolId: string,
    ): DocumentToolSnapshot {
      const host: SurfaceToolbarHost = {
        activeToolId: () => activeToolId,
        setTool: () => undefined,
        penColor: () => '#111111',
        setPenColor: () => undefined,
        penWidth: () => 2,
        setPenWidth: () => undefined,
        eraserRadius: () => 10,
        setEraserRadius: () => undefined,
        zoomFactor: () => 1,
        setZoomFactor: () => undefined,
        canInsertImage: () => false,
        chooseImage: () => undefined,
        fitToView: () => undefined,
      };
      return {
        context: `${prefix} canvas`,
        controls: buildSurfaceDrawControls(host, {
          prefix,
          tools: drawToolsFor(prefix),
        }),
      };
    }

    function controlIdFor(
      prefix: 'ink' | 'notebook' | 'whiteboard',
      toolId: string,
    ): string {
      // Whiteboard short-key dialect vs Ink/Notebook full-id dialect.
      if (prefix === 'whiteboard') {
        const shortKey = toolId.slice(toolId.lastIndexOf('.') + 1);
        return `${prefix}.tool.${shortKey}`;
      }
      return `${prefix}.tool.${toolId}`;
    }

    function graphForSnapshot(
      snapshot: DocumentToolSnapshot,
    ): ResolvedToolbarGraph {
      const byId = new Map(snapshot.controls.map((c) => [c.id, c]));
      const penId = snapshot.controls.find((c) =>
        c.id.endsWith('.pen'),
      )?.id;
      const pencilId = snapshot.controls.find((c) =>
        c.id.endsWith('.pencil'),
      )?.id;
      const eraserId = snapshot.controls.find((c) =>
        c.id.endsWith('.eraser'),
      )?.id;
      if (penId === undefined || pencilId === undefined || eraserId === undefined)
        throw new Error('builder snapshot is missing expected tools');
      return graph([
        category('surface.write', [
          item('surface.write.pen', byId.get(penId)!, 'surface.pen.ball'),
          item('surface.write.pencil', byId.get(pencilId)!, 'surface.pencil'),
        ]),
        category('surface.erase', [
          item('surface.erase.tool', byId.get(eraserId)!, 'surface.erase'),
        ]),
      ]);
    }

    for (const prefix of ['ink', 'notebook', 'whiteboard'] as const) {
      it(`resolves Pen/Eraser/Pencil through the shared builder for ${prefix}`, () => {
        const penId = controlIdFor(prefix, SURFACE_TOOL_IDS.pen);
        const pencilId = controlIdFor(prefix, SURFACE_TOOL_IDS.pencil);
        const eraserId = controlIdFor(prefix, SURFACE_TOOL_IDS.eraser);

        // Builder emits explicit exclusive-tool roles for real snapshots.
        const penProbe = builderSnapshot(prefix, SURFACE_TOOL_IDS.pen);
        for (const control of penProbe.controls) {
          if (control.kind !== 'button') continue;
          expect(control.activationRole).toBe('tool');
        }

        // Pen-active: write category + pen id on every resolver path.
        const penSnapshot = builderSnapshot(prefix, SURFACE_TOOL_IDS.pen);
        expect(findActiveSurfaceToolId(penSnapshot)).toBe(penId);
        expect(buildStylusPaletteModel(penSnapshot)?.activeToolId).toBe(penId);
        expect(resolveActiveToolCategoryId(graphForSnapshot(penSnapshot))).toBe(
          'surface.write',
        );
        expect(resolveActiveToolControlId(graphForSnapshot(penSnapshot))).toBe(
          penId,
        );

        // Eraser-active: erase category + eraser id.
        const eraserSnapshot = builderSnapshot(
          prefix,
          SURFACE_TOOL_IDS.eraser,
        );
        expect(findActiveSurfaceToolId(eraserSnapshot)).toBe(eraserId);
        expect(buildStylusPaletteModel(eraserSnapshot)?.activeToolId).toBe(
          eraserId,
        );
        expect(
          resolveActiveToolCategoryId(graphForSnapshot(eraserSnapshot)),
        ).toBe('surface.erase');
        expect(
          resolveActiveToolControlId(graphForSnapshot(eraserSnapshot)),
        ).toBe(eraserId);

        // Pencil-active: same write category as Pen, but the pencil id.
        const pencilSnapshot = builderSnapshot(
          prefix,
          SURFACE_TOOL_IDS.pencil,
        );
        expect(findActiveSurfaceToolId(pencilSnapshot)).toBe(pencilId);
        expect(buildStylusPaletteModel(pencilSnapshot)?.activeToolId).toBe(
          pencilId,
        );
        expect(
          resolveActiveToolCategoryId(graphForSnapshot(pencilSnapshot)),
        ).toBe('surface.write');
        expect(
          resolveActiveToolControlId(graphForSnapshot(pencilSnapshot)),
        ).toBe(pencilId);
      });
    }
  });

  it('keeps palette and matcher on the exclusive tool through the ownedPool/composition path', () => {
    // Mixed snapshot: tool-active Pen plus toggle-active Bold. The
    // palette is built through the composition + ownedPool path (the
    // squeeze/toolbar presentation seam); the matcher runs on the same
    // mixed snapshot. Both must stay on Pen.
    const penId = 'ink.tool.froglight.ink.pen';
    const penControl = button(penId, {
      semanticRole: 'surface.pen.ball',
      role: 'surface-tool',
      toolRole: 'pen',
      toolId: 'froglight.ink.pen',
      active: true,
      activationRole: 'tool',
    });
    const boldControl = button('markdown.bold', {
      semanticRole: 'writing.bold',
      active: true,
      activationRole: 'toggle',
    });
    const snapshot = {
      context: 'Ink canvas',
      controls: [penControl, boldControl],
    } as unknown as DocumentToolSnapshot;
    const ownedPool: readonly OwnedToolbarControl[] = [
      { control: penControl, owner: { kind: 'provider' } },
      { control: boldControl, owner: { kind: 'provider' } },
    ];
    const composition = graph([
      category('surface.write', [
        item('surface.write.pen', penControl, 'surface.pen.ball'),
      ]),
      category('writing.format', [
        item('writing.format.bold', boldControl, 'writing.bold'),
      ]),
    ]);
    const model = buildStylusPaletteModel(snapshot, {
      ownedPool,
      composition,
    });
    // Composition membership admits the Bold button as a palette tool,
    // but the toggle role keeps it out of the exclusive activeToolId.
    expect(model?.tools.map((tool) => tool.id)).toContain('markdown.bold');
    expect(model?.activeToolId).toBe(penId);
    expect(findActiveSurfaceToolId(snapshot)).toBe(penId);
    expect(resolveActiveToolCategoryId(composition)).toBe('surface.write');
    expect(resolveActiveToolControlId(composition)).toBe(penId);
  });
});
