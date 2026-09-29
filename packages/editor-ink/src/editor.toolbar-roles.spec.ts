// @vitest-environment jsdom
/**
 * Ink core tool semantic metadata.
 *
 * Proves the eight core draw tools carry the centralized `toolRole` +
 * `semanticRole` from the shared surface builder with no per-call-site
 * role table (`INK_DRAW_TOOLS` declares no `toolRole` for core ids):
 * - pen-family (pen/fountain/brush/pencil) share `toolRole: 'pen'`;
 * - highlighter/select/eraser/lasso carry their coarse roles;
 * - every core tool carries the exact `surface.*` semanticRole consumed by
 *   composition and the squeeze palette, identical to Notebook/Whiteboard.
 *
 * Seams under test: provider-neutral Document Tools `tools.snapshot()` —
 * no engine internals, no UI imports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  isExclusiveActiveToolControl,
  SURFACE_TOOL_IDS,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { InkDocumentEditorProvider } from './editor.js';
import { INK_TOOL_IDS } from './surface.js';

describe('ink core tool semantic metadata', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  function mount() {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    return new InkDocumentEditorProvider().createEditor({
      session: {
        model: emptySurface(boundedFrame(800, 600)),
        markDirty: () => undefined,
      } as never,
      parent,
    });
  }

  function byId(handle: ReturnType<typeof mount>) {
    return new Map(
      handle
        .tools!.snapshot()
        .controls.map((control) => [
          (control as { id: string }).id,
          control as unknown as Record<string, unknown>,
        ]),
    );
  }

  it('tags the core tools with centralized toolRole + semanticRole (two erasers)', () => {
    const handle = mount();
    try {
      const controls = byId(handle);
      // Independent source of truth: foundation surfaceSemanticRole mapping
      // + SurfaceToolRole pen-family grouping (no `pencil`/`brush` coarse
      // role exists, so pen-family shares `pen`).: the single eraser
      // is replaced by Stroke and Precision over the single
      // engine — distinct semantic roles, one coarse role, distinct icons.
      const expected: Record<
        string,
        { toolId: string; toolRole: string; semanticRole: string }
      > = {
        [`ink.tool.${SURFACE_TOOL_IDS.pen}`]: {
          toolId: SURFACE_TOOL_IDS.pen,
          toolRole: 'pen',
          semanticRole: 'surface.pen.ball',
        },
        [`ink.tool.${SURFACE_TOOL_IDS.fountain}`]: {
          toolId: SURFACE_TOOL_IDS.fountain,
          toolRole: 'pen',
          semanticRole: 'surface.pen.fountain',
        },
        [`ink.tool.${SURFACE_TOOL_IDS.brush}`]: {
          toolId: SURFACE_TOOL_IDS.brush,
          toolRole: 'pen',
          semanticRole: 'surface.pen.brush',
        },
        [`ink.tool.${SURFACE_TOOL_IDS.pencil}`]: {
          toolId: SURFACE_TOOL_IDS.pencil,
          toolRole: 'pen',
          semanticRole: 'surface.pencil',
        },
        [`ink.tool.${SURFACE_TOOL_IDS.highlighter}`]: {
          toolId: SURFACE_TOOL_IDS.highlighter,
          toolRole: 'highlighter',
          semanticRole: 'surface.highlighter',
        },
        [`ink.tool.${SURFACE_TOOL_IDS.select}`]: {
          toolId: SURFACE_TOOL_IDS.select,
          toolRole: 'select',
          semanticRole: 'surface.select',
        },
        [`ink.tool.${SURFACE_TOOL_IDS.eraser}.stroke`]: {
          toolId: SURFACE_TOOL_IDS.eraser,
          toolRole: 'eraser',
          semanticRole: 'surface.erase.stroke',
        },
        [`ink.tool.${SURFACE_TOOL_IDS.eraser}.precision`]: {
          toolId: SURFACE_TOOL_IDS.eraser,
          toolRole: 'eraser',
          semanticRole: 'surface.erase.precision',
        },
        [`ink.tool.${SURFACE_TOOL_IDS.lasso}`]: {
          toolId: SURFACE_TOOL_IDS.lasso,
          toolRole: 'lasso',
          semanticRole: 'surface.lasso',
        },
      };
      for (const [id, want] of Object.entries(expected)) {
        expect(controls.get(id)).toMatchObject({
          kind: 'button',
          role: 'surface-tool',
          toolId: want.toolId,
          toolRole: want.toolRole,
          semanticRole: want.semanticRole,
        });
      }
      // Legacy single eraser is gone from the snapshot (composition id
      // `surface.erase.tool` stays dormant, never renamed).
      expect(
        controls.get(`ink.tool.${SURFACE_TOOL_IDS.eraser}`),
      ).toBeUndefined();
    } finally {
      handle.destroy();
    }
  });
});

describe('ink grouped toolbar contract', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  function mount() {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    return new InkDocumentEditorProvider().createEditor({
      session: {
        model: emptySurface(boundedFrame(800, 600)),
        markDirty: () => undefined,
      } as never,
      parent,
    });
  }

  function snapshot(handle: ReturnType<typeof mount>) {
    return handle.tools!.snapshot();
  }

  /** Canonical draw order (squeeze order-preserving). */
  const CANONICAL_DRAW_IDS = [
    `ink.tool.${SURFACE_TOOL_IDS.pen}`,
    `ink.tool.${SURFACE_TOOL_IDS.fountain}`,
    `ink.tool.${SURFACE_TOOL_IDS.brush}`,
    `ink.tool.${SURFACE_TOOL_IDS.pencil}`,
    `ink.tool.${SURFACE_TOOL_IDS.highlighter}`,
    `ink.tool.${SURFACE_TOOL_IDS.eraser}.stroke`,
    `ink.tool.${SURFACE_TOOL_IDS.eraser}.precision`,
    `ink.tool.${SURFACE_TOOL_IDS.select}`,
    `ink.tool.${SURFACE_TOOL_IDS.lasso}`,
    `ink.tool.${INK_TOOL_IDS.line}`,
    `ink.tool.${INK_TOOL_IDS.rect}`,
    `ink.tool.${INK_TOOL_IDS.ellipse}`,
    `ink.tool.${INK_TOOL_IDS.triangle}`,
    `ink.tool.${INK_TOOL_IDS.diamond}`,
    `ink.tool.${INK_TOOL_IDS.text}`,
  ];

  it('emits the shared 14-slot draw grammar in canonical order, no flat fallback', () => {
    const handle = mount();
    try {
      const drawIds = snapshot(handle)
        .controls.filter(
          (control) =>
            (control as { role?: string }).role === 'surface-tool' &&
            control.group === 'draw',
        )
        .map((control) => (control as { id: string }).id);
      expect(drawIds).toEqual(CANONICAL_DRAW_IDS);
      // Every draw tool resolves a composition identity (grouped main +
      // shelf, never an unresolvable flat button).
      for (const control of snapshot(handle).controls.filter(
        (entry) => (entry as { role?: string }).role === 'surface-tool',
      )) {
        expect((control as { semanticRole?: string }).semanticRole).toMatch(
          /^surface\./,
        );
      }
    } finally {
      handle.destroy();
    }
  });

  it('carries no family-specific draw tool (Card is whiteboard-only)', () => {
    const handle = mount();
    try {
      const ids = snapshot(handle).controls.map(
        (control) => (control as { id: string }).id,
      );
      expect(ids.some((id) => id.includes('card'))).toBe(false);
      const roles = snapshot(handle)
        .controls.map(
          (control) => (control as { semanticRole?: string }).semanticRole,
        )
        .filter((role) => role !== undefined);
      expect(roles).not.toContain('surface.insert.card');
    } finally {
      handle.destroy();
    }
  });

  it('reconciles exactly one exclusive tool; Write/Erase flips stay honest', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      const exclusive = () =>
        snapshot(handle).controls.filter((control) =>
          isExclusiveActiveToolControl(control),
        );
      // Mount settles pen (baseline, no persisted last-used).
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        `ink.tool.${SURFACE_TOOL_IDS.pen}`,
      ]);
      // Write remembers its sibling honestly: fountain flips alone.
      expect(tools.execute(`ink.tool.${SURFACE_TOOL_IDS.fountain}`)).toBe(true);
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        `ink.tool.${SURFACE_TOOL_IDS.fountain}`,
      ]);
      // Manual erase flips alone and never hijacks the Write pen:
      // Stroke eraser pins the mode end-to-end.
      // Returning restores fountain, the remembered sibling.
      expect(tools.execute(`ink.tool.${SURFACE_TOOL_IDS.eraser}.stroke`)).toBe(
        true,
      );
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        `ink.tool.${SURFACE_TOOL_IDS.eraser}.stroke`,
      ]);
      // Precision pins its own mode: exactly one eraser reads active.
      expect(
        tools.execute(`ink.tool.${SURFACE_TOOL_IDS.eraser}.precision`),
      ).toBe(true);
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        `ink.tool.${SURFACE_TOOL_IDS.eraser}.precision`,
      ]);
      expect(tools.execute(`ink.tool.${SURFACE_TOOL_IDS.fountain}`)).toBe(true);
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        `ink.tool.${SURFACE_TOOL_IDS.fountain}`,
      ]);
      // Every draw control reconciles as an exclusive tool (never toggle).
      for (const control of snapshot(handle).controls.filter(
        (entry) => (entry as { role?: string }).role === 'surface-tool',
      )) {
        expect((control as { activationRole?: string }).activationRole).toBe(
          'tool',
        );
      }
    } finally {
      handle.destroy();
    }
  });

  it('backs fixed slots with live slot-source controls and per-slot isolation', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      const byId = () =>
        new Map(
          snapshot(handle).controls.map((control) => [
            (control as { id: string }).id,
            control as unknown as Record<string, unknown>,
          ]),
        );
      // slot sources: size (width + eraser), color, pen
      // settings — all present with composition identities and live values.
      expect(byId().get('ink.width')).toMatchObject({
        kind: 'choice',
        semanticRole: 'surface.style.width',
      });
      expect(byId().get('ink.color')).toMatchObject({
        kind: 'color',
        semanticRole: 'surface.style.color',
      });
      expect(byId().get('ink.eraser-radius')).toBeUndefined();
      expect(
        tools.execute(`ink.tool.${SURFACE_TOOL_IDS.eraser}.precision`),
      ).toBe(true);
      expect(byId().get('ink.eraser-radius')).toMatchObject({
        kind: 'range',
        semanticRole: 'surface.erase.size',
      });
      expect(tools.execute(`ink.tool.${SURFACE_TOOL_IDS.pen}`)).toBe(true);
      // Live size/color are family-shared — pen,
      // fountain, brush and pencil read the SAME pen-family value (switch
      // keeps Thick), while the highlighter stays independent. Assigning
      // pen size 6 lands on the shared family value, so the fountain
      // schema honestly reads '6' too. Per-slot isolation lives at the
      // slot-store level (modal edits one slot only).
      expect(tools.execute('ink.settings.pen.size', '6')).toBe(true);
      expect(byId().get('ink.width')).toMatchObject({ value: '6' });
      expect(tools.execute(`ink.tool.${SURFACE_TOOL_IDS.fountain}`)).toBe(true);
      expect(byId().get('ink.settings.fountain.size')).toMatchObject({
        value: '6',
      });
      // eraser mode rides the toolbar tool, never a settings
      // dropdown — legacy writes resolve false, and selecting Precision
      // tool leaves the pen width untouched.
      expect(tools.execute('ink.settings.eraser.mode', 'unknown')).toBe(false);
      expect(
        tools.execute(`ink.tool.${SURFACE_TOOL_IDS.eraser}.precision`),
      ).toBe(true);
      expect(tools.execute(`ink.tool.${SURFACE_TOOL_IDS.pen}`)).toBe(true);
      expect(byId().get('ink.width')).toMatchObject({ value: '6' });
    } finally {
      handle.destroy();
    }
  });

  it('resets to the default pen on fresh mount (no provider last-used persistence)', () => {
    const first = mount();
    try {
      // Stroke eraser reads active end-to-end.
      expect(
        first.tools!.execute(`ink.tool.${SURFACE_TOOL_IDS.eraser}.stroke`),
      ).toBe(true);
      expect(
        (
          first
            .tools!.snapshot()
            .controls.find(
              (control) =>
                (control as { id: string }).id ===
                `ink.tool.${SURFACE_TOOL_IDS.eraser}.stroke`,
            ) as unknown as { active?: boolean }
        ).active,
      ).toBe(true);
    } finally {
      first.destroy();
    }
    // last-used is ephemeral UI memory, never provider
    // state — a reopen settles pen again.
    const second = mount();
    try {
      expect(
        (
          second
            .tools!.snapshot()
            .controls.find(
              (control) =>
                (control as { id: string }).id ===
                `ink.tool.${SURFACE_TOOL_IDS.pen}`,
            ) as unknown as { active?: boolean }
        ).active,
      ).toBe(true);
    } finally {
      second.destroy();
    }
  });

  it('keeps history, zoom, fit, and export per family', () => {
    const handle = mount();
    try {
      const controls = snapshot(handle);
      const ids = controls.controls.map(
        (control) => (control as { id: string }).id,
      );
      // Zoom cluster (float.bottom-right) + fit + export + frame sizing.
      for (const id of [
        'ink.zoom-out',
        'ink.zoom-reset',
        'ink.zoom',
        'ink.zoom-slider',
        'ink.zoom-in',
        'ink.fit',
        'ink.export',
        'ink.frame-width',
        'ink.frame-height',
      ]) {
        expect(ids).toContain(id);
      }
      // History seam (float.top-left): nothing to undo on a fresh page.
      expect(handle.canExecCommand?.('undo')).toBe(false);
      expect(handle.canExecCommand?.('redo')).toBe(false);
    } finally {
      handle.destroy();
    }
  });
});
