// @vitest-environment jsdom
/**
 * Notebook core tool semantic metadata.
 *
 * Proves the eight core draw tools carry the centralized `toolRole` +
 * `semanticRole` from the shared surface builder with no per-call-site
 * role table (`NOTEBOOK_DRAW_TOOLS` declares no `toolRole` for core ids):
 * - pen-family (pen/fountain/brush/pencil) share `toolRole: 'pen'`;
 * - highlighter/select/eraser/lasso carry their coarse roles;
 * - every core tool carries the exact `surface.*` semanticRole consumed by
 *   composition and the squeeze palette, identical to Ink/Whiteboard.
 *
 * Seams under test: provider-neutral Document Tools `tools.snapshot()` —
 * no engine internals, no UI imports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  isExclusiveActiveToolControl,
  notebookPage,
  pdfNotebookPage,
  SURFACE_TOOL_IDS,
  type NotebookModel,
  workspacePath,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { NotebookDocumentEditorProvider } from './editor.js';
import { PAGE_TOOL_IDS } from './page-surface.js';

function fixture(): NotebookModel {
  const model = emptyNotebook('Toolbar roles fixture');
  appendPage(
    model,
    notebookPage('p1', { surface: emptySurface(boundedFrame(800, 600)) }),
  );
  return model;
}

describe('notebook core tool semantic metadata', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  function mount(model: NotebookModel = fixture()) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    return new NotebookDocumentEditorProvider().createEditor({
      session: { model, markDirty: () => undefined } as never,
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
      // Notebook page tool ids spread the foundation surface ids, so the
      // core engine ids — and the centralized builder default — apply
      // unchanged: single eraser replaced by two modes over the
      // single engine. Independent source of truth: foundation
      // surfaceSemanticRole mapping + SurfaceToolRole pen-family grouping.
      const expected: Record<
        string,
        { toolId: string; toolRole: string; semanticRole: string }
      > = {
        [`notebook.tool.${SURFACE_TOOL_IDS.pen}`]: {
          toolId: SURFACE_TOOL_IDS.pen,
          toolRole: 'pen',
          semanticRole: 'surface.pen.ball',
        },
        [`notebook.tool.${SURFACE_TOOL_IDS.fountain}`]: {
          toolId: SURFACE_TOOL_IDS.fountain,
          toolRole: 'pen',
          semanticRole: 'surface.pen.fountain',
        },
        [`notebook.tool.${SURFACE_TOOL_IDS.brush}`]: {
          toolId: SURFACE_TOOL_IDS.brush,
          toolRole: 'pen',
          semanticRole: 'surface.pen.brush',
        },
        [`notebook.tool.${SURFACE_TOOL_IDS.pencil}`]: {
          toolId: SURFACE_TOOL_IDS.pencil,
          toolRole: 'pen',
          semanticRole: 'surface.pencil',
        },
        [`notebook.tool.${SURFACE_TOOL_IDS.highlighter}`]: {
          toolId: SURFACE_TOOL_IDS.highlighter,
          toolRole: 'highlighter',
          semanticRole: 'surface.highlighter',
        },
        [`notebook.tool.${SURFACE_TOOL_IDS.select}`]: {
          toolId: SURFACE_TOOL_IDS.select,
          toolRole: 'select',
          semanticRole: 'surface.select',
        },
        [`notebook.tool.${SURFACE_TOOL_IDS.eraser}.stroke`]: {
          toolId: SURFACE_TOOL_IDS.eraser,
          toolRole: 'eraser',
          semanticRole: 'surface.erase.stroke',
        },
        [`notebook.tool.${SURFACE_TOOL_IDS.eraser}.precision`]: {
          toolId: SURFACE_TOOL_IDS.eraser,
          toolRole: 'eraser',
          semanticRole: 'surface.erase.precision',
        },
        [`notebook.tool.${SURFACE_TOOL_IDS.lasso}`]: {
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
      expect(
        controls.get(`notebook.tool.${SURFACE_TOOL_IDS.eraser}`),
      ).toBeUndefined();
    } finally {
      handle.destroy();
    }
  });

  it('exposes the shared text roles as creation defaults without a selection', () => {
    const handle = mount();
    try {
      const controls = handle.tools!.snapshot().controls;
      const textControls = controls.filter(
        (control) => control.group === 'text',
      );
      expect(textControls).toHaveLength(7);
      expect(
        textControls.map(
          (control) => (control as { semanticRole?: string }).semanticRole,
        ),
      ).toEqual([
        'surface.text.style',
        'surface.text.size',
        'surface.text.bold',
        'surface.text.italic',
        'surface.text.align',
        'surface.text.color',
        'surface.text.wrap',
      ]);
    } finally {
      handle.destroy();
    }
  });
});

describe('notebook grouped toolbar contract', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  function mount(model: NotebookModel = fixture()) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    return new NotebookDocumentEditorProvider().createEditor({
      session: { model, markDirty: () => undefined } as never,
      parent,
    });
  }

  function snapshot(handle: ReturnType<typeof mount>) {
    return handle.tools!.snapshot();
  }

  /** Canonical 14-slot shared order in the Notebook page-id dialect (trio).*/
  const CANONICAL_DRAW_IDS = [
    PAGE_TOOL_IDS.pen,
    PAGE_TOOL_IDS.fountain,
    PAGE_TOOL_IDS.brush,
    PAGE_TOOL_IDS.pencil,
    PAGE_TOOL_IDS.highlighter,
    `${PAGE_TOOL_IDS.eraser}.stroke`,
    `${PAGE_TOOL_IDS.eraser}.precision`,
    PAGE_TOOL_IDS.select,
    PAGE_TOOL_IDS.lasso,
    PAGE_TOOL_IDS.line,
    PAGE_TOOL_IDS.rect,
    PAGE_TOOL_IDS.ellipse,
    PAGE_TOOL_IDS.triangle,
    PAGE_TOOL_IDS.diamond,
    PAGE_TOOL_IDS.text,
  ].map((toolId) => `notebook.tool.${toolId}`);

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

  it('keeps pager navigation, actions, template, paper, outline, ruler, and PDF-insert placements', () => {
    const handle = mount();
    try {
      const ids = snapshot(handle).controls.map(
        (control) => (control as { id: string }).id,
      );
      // Notebook pager additions stay provider-local with unchanged
      // placements (constraint): nav, template/paper/outline,
      // actions, ruler, PDF insert, sizing, export.
      for (const id of [
        'notebook.previous',
        'notebook.page',
        'notebook.next',
        'notebook.template',
        'notebook.go-to-page',
        'notebook.paper-spacing',
        'notebook.paper-color',
        'notebook.paper-reset',
        'notebook.add',
        'notebook.duplicate',
        'notebook.delete',
        'notebook.ruler',
        'notebook.ruler-angle',
        'notebook.ruler-center',
        'notebook.insert-pdf-before',
        'notebook.insert-pdf-after',
        'notebook.page-size-preset',
        'notebook.orientation',
        'notebook.page-width',
        'notebook.page-height',
        'notebook.export',
        'notebook.export-all',
      ]) {
        expect(ids).toContain(id);
      }
      // No Card leaks into Notebook (whiteboard-only).
      expect(ids.some((id) => id.includes('card'))).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('reconciles Write/Erase flips exclusively with no cross-group hijack', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      const exclusive = () =>
        snapshot(handle).controls.filter((control) =>
          isExclusiveActiveToolControl(control),
        );
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        `notebook.tool.${PAGE_TOOL_IDS.pen}`,
      ]);
      expect(tools.execute(`notebook.tool.${PAGE_TOOL_IDS.fountain}`)).toBe(
        true,
      );
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        `notebook.tool.${PAGE_TOOL_IDS.fountain}`,
      ]);
      // Manual erase flips alone; returning restores the Write
      // sibling without hijack. Both erasers pin the mode
      // end-to-end.
      expect(
        tools.execute(`notebook.tool.${PAGE_TOOL_IDS.eraser}.stroke`),
      ).toBe(true);
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        `notebook.tool.${PAGE_TOOL_IDS.eraser}.stroke`,
      ]);
      expect(
        tools.execute(`notebook.tool.${PAGE_TOOL_IDS.eraser}.precision`),
      ).toBe(true);
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        `notebook.tool.${PAGE_TOOL_IDS.eraser}.precision`,
      ]);
      expect(tools.execute(`notebook.tool.${PAGE_TOOL_IDS.fountain}`)).toBe(
        true,
      );
      expect(exclusive().map((c) => (c as { id: string }).id)).toEqual([
        `notebook.tool.${PAGE_TOOL_IDS.fountain}`,
      ]);
    } finally {
      handle.destroy();
    }
  });

  it('reports source-select honestly and returns to surface authoring intact', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      // Template pages carry no PDF source, so no policy override applies:
      // the host default (settled) reports the pen through source-select
      // mode (ordinary-path delegation, uniform with
      // Ink/Whiteboard). Explicit surface selection still restores.
      expect(tools.execute('notebook.source-select')).toBe(true);
      let exclusive = snapshot(handle).controls.filter((control) =>
        isExclusiveActiveToolControl(control),
      );
      expect(exclusive.map((c) => (c as { id: string }).id)).toEqual([
        `notebook.tool.${PAGE_TOOL_IDS.pen}`,
      ]);
      expect(tools.execute(`notebook.tool.${PAGE_TOOL_IDS.fountain}`)).toBe(
        true,
      );
      exclusive = snapshot(handle).controls.filter((control) =>
        isExclusiveActiveToolControl(control),
      );
      expect(exclusive.map((c) => (c as { id: string }).id)).toEqual([
        `notebook.tool.${PAGE_TOOL_IDS.fountain}`,
      ]);
    } finally {
      handle.destroy();
    }
  });

  it('marks Select active in source-select mode on pdf-backed pages (documented policy divergence)', () => {
    const model = emptyNotebook('PDF divergence fixture');
    appendPage(
      model,
      pdfNotebookPage('pdf1', {
        asset: {
          path: workspacePath('attachments/source.pdf'),
          sha256: 'sha-test',
        },
        pageIndex: 0,
        pageBox: { widthPt: 612, heightPt: 792 },
        surface: emptySurface(boundedFrame(612, 792)),
      }),
    );
    const handle = mount(model);
    try {
      const tools = handle.tools!;
      // Baseline: surface authoring settles pen (ordinary settled path,
      // even on pdf pages while authoring).
      let exclusive = snapshot(handle).controls.filter((control) =>
        isExclusiveActiveToolControl(control),
      );
      expect(exclusive.map((c) => (c as { id: string }).id)).toEqual([
        `notebook.tool.${PAGE_TOOL_IDS.pen}`,
      ]);
      // PDF policy divergence: entering source-select marks Select active
      // although the engine still holds the pen — the provider-computed
      // source mode, never a guessed role. Ordinary siblings read
      // inactive through the same predicate.
      expect(tools.execute('notebook.source-select')).toBe(true);
      exclusive = snapshot(handle).controls.filter((control) =>
        isExclusiveActiveToolControl(control),
      );
      expect(exclusive.map((c) => (c as { id: string }).id)).toEqual([
        `notebook.tool.${PAGE_TOOL_IDS.select}`,
      ]);
      // Explicit surface selection wins back authoring with the settled
      // tool intact.
      expect(tools.execute(`notebook.tool.${PAGE_TOOL_IDS.pen}`)).toBe(true);
      exclusive = snapshot(handle).controls.filter((control) =>
        isExclusiveActiveToolControl(control),
      );
      expect(exclusive.map((c) => (c as { id: string }).id)).toEqual([
        `notebook.tool.${PAGE_TOOL_IDS.pen}`,
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
      expect(byId().get('notebook.width')).toMatchObject({
        kind: 'choice',
        semanticRole: 'surface.style.width',
      });
      expect(byId().get('notebook.color')).toMatchObject({
        kind: 'color',
        semanticRole: 'surface.style.color',
      });
      expect(byId().get('notebook.eraser-radius')).toBeUndefined();
      expect(
        tools.execute(`notebook.tool.${PAGE_TOOL_IDS.eraser}.precision`),
      ).toBe(true);
      expect(byId().get('notebook.eraser-radius')).toMatchObject({
        kind: 'range',
        semanticRole: 'surface.erase.size',
      });
      expect(tools.execute(`notebook.tool.${PAGE_TOOL_IDS.pen}`)).toBe(true);
      // Live size/color are family-shared — fountain reads the
      // same pen-family value (switch keeps the size). Per-slot isolation
      // lives at the slot-store level (modal edits one slot).
      expect(tools.execute('notebook.settings.pen.size', '5')).toBe(true);
      expect(byId().get('notebook.width')).toMatchObject({ value: '5' });
      expect(tools.execute(`notebook.tool.${PAGE_TOOL_IDS.fountain}`)).toBe(
        true,
      );
      expect(byId().get('notebook.settings.fountain.size')).toMatchObject({
        value: '5',
      });
      expect(tools.execute(`notebook.tool.${PAGE_TOOL_IDS.pen}`)).toBe(true);
      expect(byId().get('notebook.width')).toMatchObject({ value: '5' });
    } finally {
      handle.destroy();
    }
  });

  it('resets to the default pen on fresh mount (no provider last-used persistence)', () => {
    const first = mount();
    try {
      expect(
        first.tools!.execute(`notebook.tool.${PAGE_TOOL_IDS.eraser}.stroke`),
      ).toBe(true);
    } finally {
      first.destroy();
    }
    const second = mount();
    try {
      const exclusive = snapshot(second).controls.filter((control) =>
        isExclusiveActiveToolControl(control),
      );
      expect(exclusive.map((c) => (c as { id: string }).id)).toEqual([
        `notebook.tool.${PAGE_TOOL_IDS.pen}`,
      ]);
    } finally {
      second.destroy();
    }
  });

  it('keeps history, zoom, and fit reporting with honest empty-stack states', () => {
    const handle = mount();
    try {
      const ids = snapshot(handle).controls.map(
        (control) => (control as { id: string }).id,
      );
      for (const id of [
        'notebook.zoom-out',
        'notebook.zoom-reset',
        'notebook.zoom',
        'notebook.zoom-slider',
        'notebook.zoom-in',
        'notebook.fit',
      ]) {
        expect(ids).toContain(id);
      }
      expect(handle.canExecCommand?.('undo')).toBe(false);
      expect(handle.canExecCommand?.('redo')).toBe(false);
    } finally {
      handle.destroy();
    }
    // Empty stacks disable zoom honestly while pager chrome survives.
    const empty = mount(emptyNotebook('Empty stacks fixture'));
    try {
      const byId = new Map(
        snapshot(empty).controls.map((control) => [
          (control as { id: string }).id,
          control as unknown as Record<string, unknown>,
        ]),
      );
      expect(byId.get('notebook.page')).toMatchObject({
        kind: 'status',
        label: 'No pages',
      });
      for (const id of [
        'notebook.zoom-out',
        'notebook.zoom-reset',
        'notebook.zoom',
        'notebook.zoom-slider',
        'notebook.zoom-in',
      ]) {
        expect(byId.get(id)).toMatchObject({ disabled: true });
      }
    } finally {
      empty.destroy();
    }
  });
});
