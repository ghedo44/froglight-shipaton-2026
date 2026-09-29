// @vitest-environment jsdom
/**
 * Whiteboard core tool semantic metadata.
 *
 * Proves the eight primary draw tools carry explicit `toolRole` +
 * `semanticRole` so composition, active-tool reconciliation, and the squeeze
 * palette resolve Whiteboard identically to Ink/Notebook:
 * - pen-family (pen/fountain/brush/pencil) share `toolRole: 'pen'`;
 * - highlighter/select/eraser/lasso carry their coarse roles;
 * - every core tool carries the exact `surface.*` semanticRole consumed by
 *   `DEFAULT_TOOLBAR_ITEMS` (consistent with foundation
 *   `surfaceSemanticRole` mapping);
 * - short-key control ids are unchanged (compat).
 *
 * Seams under test: provider-neutral Document Tools `tools.snapshot()` and
 * `tools.execute()` — no engine internals, no UI imports (provider must not
 * depend on `ui`; the assertions pin the metadata `isSurfaceEraserControl`
 * and the palette/composition matchers consume).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptySurface,
  infiniteFrame,
  isExclusiveActiveToolControl,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { WhiteboardDocumentEditorProvider } from './editor.js';

describe('whiteboard core tool semantic metadata', () => {
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
    return new WhiteboardDocumentEditorProvider().createEditor({
      session: {
        model: emptySurface(infiniteFrame()),
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

  it('tags the primary tools with explicit toolRole + semanticRole (two erasers)', () => {
    const handle = mount();
    try {
      const controls = byId(handle);
      // Independent source of truth: foundation surfaceSemanticRole mapping
      // + SurfaceToolRole pen-family grouping (no `pencil`/`brush` coarse
      // role exists, so pen-family shares `pen`).: single eraser
      // replaced by two modes over the single engine.
      const expected: Record<
        string,
        { toolId: string; toolRole: string; semanticRole: string }
      > = {
        'whiteboard.tool.pen': {
          toolId: 'froglight.ink.pen',
          toolRole: 'pen',
          semanticRole: 'surface.pen.ball',
        },
        'whiteboard.tool.fountain': {
          toolId: 'froglight.ink.fountain',
          toolRole: 'pen',
          semanticRole: 'surface.pen.fountain',
        },
        'whiteboard.tool.brush': {
          toolId: 'froglight.ink.brush',
          toolRole: 'pen',
          semanticRole: 'surface.pen.brush',
        },
        'whiteboard.tool.pencil': {
          toolId: 'froglight.ink.pencil',
          toolRole: 'pen',
          semanticRole: 'surface.pencil',
        },
        'whiteboard.tool.highlighter': {
          toolId: 'froglight.ink.highlighter',
          toolRole: 'highlighter',
          semanticRole: 'surface.highlighter',
        },
        'whiteboard.tool.select': {
          toolId: 'froglight.ink.select',
          toolRole: 'select',
          semanticRole: 'surface.select',
        },
        'whiteboard.tool.eraser-stroke': {
          toolId: 'froglight.ink.eraser',
          toolRole: 'eraser',
          semanticRole: 'surface.erase.stroke',
        },
        'whiteboard.tool.eraser-precision': {
          toolId: 'froglight.ink.eraser',
          toolRole: 'eraser',
          semanticRole: 'surface.erase.precision',
        },
        'whiteboard.tool.lasso': {
          toolId: 'froglight.ink.lasso',
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
      // Legacy single eraser gone (composition id never renamed, dormant).
      expect(controls.get('whiteboard.tool.eraser')).toBeUndefined();
    } finally {
      handle.destroy();
    }
  });

  it('keeps short-key control ids stable for compat', () => {
    const handle = mount();
    try {
      const ids = handle
        .tools!.snapshot()
        .controls.map((control) => (control as { id: string }).id);
      for (const shortKey of [
        'pen',
        'fountain',
        'brush',
        'pencil',
        'highlighter',
        'select',
        'eraser-stroke',
        'eraser-precision',
        'lasso',
      ]) {
        expect(ids).toContain(`whiteboard.tool.${shortKey}`);
      }
      // No full-engine-id dialect leaks into whiteboard control ids.
      expect(ids.filter((id) => id.includes('froglight.ink.'))).toEqual([]);
    } finally {
      handle.destroy();
    }
  });

  it('exposes both erasers exactly as the semantic eraser matcher consumes them', () => {
    const handle = mount();
    try {
      const controls = byId(handle);
      // Mirrors `isSurfaceEraserControl` (ui/stylus-accessory-helpers.ts):
      // metadata-bearing controls are authoritative on `toolRole` alone.
      // both fixed-mode tools carry `toolRole: 'eraser'` over
      // the single engine, with distinct semantic roles.
      for (const [id, role] of [
        ['whiteboard.tool.eraser-stroke', 'surface.erase.stroke'],
        ['whiteboard.tool.eraser-precision', 'surface.erase.precision'],
      ] as const) {
        const eraser = controls.get(id) as unknown as {
          kind: string;
          role?: string;
          toolRole?: string;
          semanticRole?: string;
        };
        expect(eraser.kind).toBe('button');
        expect(eraser.role).toBe('surface-tool');
        expect(eraser.toolRole).toBe('eraser');
        expect(eraser.semanticRole).toBe(role);
      }
      // No other primary tool may match as eraser.
      for (const id of [
        'whiteboard.tool.pen',
        'whiteboard.tool.fountain',
        'whiteboard.tool.brush',
        'whiteboard.tool.pencil',
        'whiteboard.tool.highlighter',
        'whiteboard.tool.select',
        'whiteboard.tool.lasso',
      ]) {
        const other = controls.get(id) as unknown as {
          role?: string;
          toolRole?: string;
        };
        expect(
          other.role === 'surface-tool' && other.toolRole === 'eraser',
        ).toBe(false);
      }
    } finally {
      handle.destroy();
    }
  });

  it('reconciles Pen -> Eraser as an exclusive active-tool transition', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      expect(tools.execute('whiteboard.tool.pen')).toBe(true);
      let controls = byId(handle);
      expect(controls.get('whiteboard.tool.pen')).toMatchObject({
        active: true,
        semanticRole: 'surface.pen.ball',
      });
      expect(controls.get('whiteboard.tool.eraser-stroke')).toMatchObject({
        active: false,
        semanticRole: 'surface.erase.stroke',
      });
      expect(tools.execute('whiteboard.tool.eraser-stroke')).toBe(true);
      controls = byId(handle);
      expect(controls.get('whiteboard.tool.eraser-stroke')).toMatchObject({
        active: true,
      });
      expect(controls.get('whiteboard.tool.pen')).toMatchObject({
        active: false,
      });
      // Precision pins its own mode end-to-end.
      expect(tools.execute('whiteboard.tool.eraser-precision')).toBe(true);
      controls = byId(handle);
      expect(controls.get('whiteboard.tool.eraser-precision')).toMatchObject({
        active: true,
      });
      expect(controls.get('whiteboard.tool.eraser-stroke')).toMatchObject({
        active: false,
      });
    } finally {
      handle.destroy();
    }
  });
});

describe('whiteboard grouped toolbar contract', () => {
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
    return new WhiteboardDocumentEditorProvider().createEditor({
      session: {
        model: emptySurface(infiniteFrame()),
        markDirty: () => undefined,
      } as never,
      parent,
    });
  }

  function snapshot(handle: ReturnType<typeof mount>) {
    return handle.tools!.snapshot();
  }

  /** Canonical shared order in whiteboard short-key dialect. */
  const CANONICAL_DRAW_IDS = [
    'pen',
    'fountain',
    'brush',
    'pencil',
    'highlighter',
    'eraser-stroke',
    'eraser-precision',
    'select',
    'lasso',
    'line',
    'rect',
    'ellipse',
    'triangle',
    'diamond',
    'text',
  ].map((key) => `whiteboard.tool.${key}`);

  it('emits the shared 14-slot grammar in canonical order plus Card only', () => {
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
      // Card is the sole family-specific draw tool: insert group,
      // card identity, exclusive-tool semantics like every sibling.
      const controls = snapshot(handle).controls;
      const carded = controls.filter(
        (control) =>
          (control as { semanticRole?: string }).semanticRole ===
          'surface.insert.card',
      );
      expect(carded.map((c) => (c as { id: string }).id)).toEqual([
        'whiteboard.tool.card',
      ]);
      expect(carded[0]).toMatchObject({
        kind: 'button',
        group: 'insert',
        label: 'Card',
        activationRole: 'tool',
      });
    } finally {
      handle.destroy();
    }
  });

  it('reconciles Card as an exclusive tool without hijacking Write memory', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      const exclusive = () =>
        snapshot(handle).controls.filter((control) =>
          isExclusiveActiveToolControl(control),
        );
      expect(tools.execute('whiteboard.tool.fountain')).toBe(true);
      expect(tools.execute('whiteboard.tool.card')).toBe(true);
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        'whiteboard.tool.card',
      ]);
      // Returning to Write restores the remembered pen sibling:
      // Card never hijacks it.
      expect(tools.execute('whiteboard.tool.fountain')).toBe(true);
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        'whiteboard.tool.fountain',
      ]);
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
      expect(byId().get('whiteboard.width')).toMatchObject({
        kind: 'choice',
        semanticRole: 'surface.style.width',
      });
      expect(byId().get('whiteboard.color')).toMatchObject({
        kind: 'color',
        semanticRole: 'surface.style.color',
      });
      expect(byId().get('whiteboard.eraser-radius')).toBeUndefined();
      expect(tools.execute('whiteboard.tool.eraser-precision')).toBe(true);
      expect(byId().get('whiteboard.eraser-radius')).toMatchObject({
        kind: 'range',
        semanticRole: 'surface.erase.size',
      });
      expect(tools.execute('whiteboard.tool.pen')).toBe(true);
      // Live size/color are family-shared — fountain reads the
      // same pen-family value (switch keeps the size). Per-slot isolation
      // lives at the slot-store level (modal edits one slot).
      expect(tools.execute('whiteboard.settings.pen.size', '6')).toBe(true);
      expect(byId().get('whiteboard.width')).toMatchObject({ value: '6' });
      expect(tools.execute('whiteboard.tool.fountain')).toBe(true);
      expect(byId().get('whiteboard.settings.fountain.size')).toMatchObject({
        value: '6',
      });
      expect(tools.execute('whiteboard.tool.pen')).toBe(true);
      expect(byId().get('whiteboard.width')).toMatchObject({ value: '6' });
    } finally {
      handle.destroy();
    }
  });

  it('resets to the default pen on fresh mount (no provider last-used persistence)', () => {
    const first = mount();
    try {
      expect(first.tools!.execute('whiteboard.tool.eraser-stroke')).toBe(true);
    } finally {
      first.destroy();
    }
    const second = mount();
    try {
      const exclusive = snapshot(second).controls.filter((control) =>
        isExclusiveActiveToolControl(control),
      );
      expect(exclusive.map((c) => (c as { id: string }).id)).toEqual([
        'whiteboard.tool.pen',
      ]);
    } finally {
      second.destroy();
    }
  });

  it('keeps zoom and fit controls (infinite board)', () => {
    const handle = mount();
    try {
      const controls = snapshot(handle);
      const ids = controls.controls.map(
        (control) => (control as { id: string }).id,
      );
      for (const id of [
        'whiteboard.zoom-out',
        'whiteboard.zoom-reset',
        'whiteboard.zoom',
        'whiteboard.zoom-slider',
        'whiteboard.zoom-in',
        'whiteboard.fit',
      ]) {
        expect(ids).toContain(id);
      }
      expect(handle.canExecCommand?.('undo')).toBe(false);
      expect(handle.canExecCommand?.('redo')).toBe(false);
    } finally {
      handle.destroy();
    }
  });
});
