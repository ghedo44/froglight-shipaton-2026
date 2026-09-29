// @vitest-environment jsdom
/**
 * Golden characterization of the Notebook Document Tools snapshot
 * (problem 6). Pins the surface subset (draw, style, zoom, image) that the
 * shared surface toolbar builder will own, plus the pager controls that must
 * stay provider-local, so the refactor cannot absorb pager logic or rename
 * the contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  notebookPage,
  textObject,
  textRoleOf,
  type NotebookModel,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { NotebookDocumentEditorProvider } from './editor.js';

function fixture(): NotebookModel {
  const model = emptyNotebook('Toolbar golden');
  appendPage(
    model,
    notebookPage('p1', { surface: emptySurface(boundedFrame(800, 600)) }),
  );
  return model;
}

describe('notebook toolbar golden', () => {
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

  it('exposes the surface draw subset with notebook tool ids', () => {
    const handle = mount();
    try {
      const ids = handle
        .tools!.snapshot()
        .controls.map((control) => (control as { id: string }).id);
      // canonical family order: Write pens, two Erasers,
      // Select pair, Shapes trio, Text — identical across Ink/Notebook/
      // Whiteboard; only the engine-id dialect (Notebook text id) is
      // provider-local (single eraser replaced; `surface.erase.tool` stays
      // dormant, never renamed).
      expect(ids.slice(0, 15)).toEqual([
        'notebook.tool.froglight.ink.pen',
        'notebook.tool.froglight.ink.fountain',
        'notebook.tool.froglight.ink.brush',
        'notebook.tool.froglight.ink.pencil',
        'notebook.tool.froglight.ink.highlighter',
        'notebook.tool.froglight.ink.eraser.stroke',
        'notebook.tool.froglight.ink.eraser.precision',
        'notebook.tool.froglight.ink.select',
        'notebook.tool.froglight.ink.lasso',
        'notebook.tool.froglight.ink.line',
        'notebook.tool.froglight.ink.rect',
        'notebook.tool.froglight.ink.ellipse',
        'notebook.tool.froglight.ink.triangle',
        'notebook.tool.froglight.ink.diamond',
        'notebook.tool.froglight.notebook.text',
      ]);
      expect(ids).toContain('notebook.color');
      expect(ids).toContain('notebook.width');
      expect(ids).not.toContain('notebook.eraser-radius');
      expect(ids).toContain('notebook.image');
      // No cross-family contamination.
      expect(ids.some((id) => id.startsWith('ink.'))).toBe(false);
      expect(ids.some((id) => id.startsWith('whiteboard.'))).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('exposes editable text defaults without a text selection', () => {
    const handle = mount();
    try {
      const controls = handle.tools!.snapshot().controls;
      const ids = controls.map((control) => (control as { id: string }).id);
      // presentation slice: no text selected, so no text group is
      // emitted — composition items stay unresolved (never synthesized,
      // never disabled placeholders).
      for (const id of [
        'notebook.text.style',
        'notebook.text.size',
        'notebook.text.bold',
        'notebook.text.italic',
        'notebook.text.align',
        'notebook.text.color',
        'notebook.text.wrap',
      ]) {
        expect(ids).toContain(id);
      }
      expect(
        controls.filter((control) => control.group === 'text'),
      ).toHaveLength(7);
    } finally {
      handle.destroy();
    }
  });

  it('routes grouped surface-text ids to creation defaults before placement', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      const before = tools.snapshot().controls.length;
      expect(tools.execute('notebook.text.style', 'h1')).toBe(true);
      expect(tools.execute('notebook.text.bold')).toBe(true);
      expect(tools.execute('notebook.text.align', 'center')).toBe(true);
      expect(tools.execute('notebook.text.wrap')).toBe(true);
      expect(tools.snapshot().controls.length).toBe(before);
      expect(tools.snapshot().controls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'notebook.text.style', value: 'h1' }),
          expect.objectContaining({ id: 'notebook.text.bold', active: true }),
          expect.objectContaining({
            id: 'notebook.text.align',
            value: 'center',
          }),
          expect.objectContaining({ id: 'notebook.text.wrap', active: true }),
        ]),
      );
    } finally {
      handle.destroy();
    }
  });

  it('exposes grouped surface text with the shared presentation when text is selected', () => {
    const model = fixture();
    const page = model.pages['p1'];
    if (page?.kind !== 'page') throw new Error('expected a page');
    const record = textObject('t1', { x: 10, y: 20, text: 'Title' });
    page.surface.objects['t1'] = record;
    page.surface.order.push('t1');
    const handle = mount(model);
    try {
      (
        handle as unknown as {
          setSelectionForTest(ids: readonly string[]): void;
        }
      ).setSelectionForTest(['t1']);
      const controls = handle.tools!.snapshot().controls;
      const ids = controls.map((control) => (control as { id: string }).id);
      // Canonical slot order Style, Size, Bold, Italic, Align, Color, Wrap
      // same presentation table as Ink/Whiteboard, only the
      // dialect differs.
      expect(
        ids.slice(
          ids.indexOf('notebook.text.style'),
          ids.indexOf('notebook.text.style') + 7,
        ),
      ).toEqual([
        'notebook.text.style',
        'notebook.text.size',
        'notebook.text.bold',
        'notebook.text.italic',
        'notebook.text.align',
        'notebook.text.color',
        'notebook.text.wrap',
      ]);
      const byId = new Map(
        controls.map((control) => [
          (control as { id: string }).id,
          control as unknown as Record<string, unknown>,
        ]),
      );
      expect(byId.get('notebook.text.style')).toMatchObject({
        kind: 'choice',
        group: 'text',
        label: 'Text style',
        value: 'body',
        semanticRole: 'surface.text.style',
      });
      expect(byId.get('notebook.text.size')).toMatchObject({
        kind: 'number',
        group: 'text',
        label: 'Font size',
        value: 16,
        semanticRole: 'surface.text.size',
      });
      expect(byId.get('notebook.text.color')).toMatchObject({
        kind: 'color',
        group: 'text',
        label: 'Text color',
        value: '#37352f',
        semanticRole: 'surface.text.color',
      });
      // Shared write path still routes live: H1 → heading + 24.
      expect(handle.tools!.execute('notebook.text.style', 'h1')).toBe(true);
      expect(textRoleOf(page.surface.objects['t1']!)).toBe('heading');
      expect(page.surface.objects['t1']!.size).toBe(24);
    } finally {
      handle.destroy();
    }
  });

  it('exposes second-tap settings for the active page tool', () => {
    const handle = mount();
    try {
      const ids = handle
        .tools!.snapshot()
        .controls.map((control) => (control as { id: string }).id);
      // Default tool is pen: the conditional ball-pen schema rides unplaced
      // (fixed round nib, so no tip control — see BRUSH_ADVANCED_SUPPORT).
      for (const id of [
        'notebook.settings.pen.type',
        'notebook.settings.pen.size',
        'notebook.settings.pen.color',
        'notebook.settings.pen.pressure',
        // pen gesture toggles match Ink/Whiteboard.
        'notebook.settings.pen.gesture-draw-hold',
        'notebook.settings.pen.gesture-scribble',
        'notebook.settings.pen.gesture-circle',
      ]) {
        expect(ids).toContain(id);
      }
      // Settings writes fan out through the pager presets.:
      // eraser mode rides the toolbar trio, never a settings dropdown —
      // legacy writes resolve false (never a crash).
      expect(handle.tools!.execute('notebook.settings.pen.size', '5')).toBe(
        true,
      );
      expect(
        handle.tools!.execute('notebook.settings.eraser.mode', 'unknown'),
      ).toBe(false);
      expect(
        handle.tools!.execute('notebook.settings.eraser.mode', 'vaporize'),
      ).toBe(false);
      expect(handle.tools!.execute('notebook.settings.pen.nope', '5')).toBe(
        false,
      );
    } finally {
      handle.destroy();
    }
  });

  it('shares style values with the Surface family defaults', () => {
    const handle = mount();
    try {
      const byId = new Map(
        handle
          .tools!.snapshot()
          .controls.map((control) => [
            (control as { id: string }).id,
            control as unknown as Record<string, unknown>,
          ]),
      );
      expect(byId.get('notebook.color')).toMatchObject({
        kind: 'color',
        group: 'style',
        label: 'Stroke color',
        value: '#37352f',
      });
      expect(byId.get('notebook.width')).toMatchObject({
        kind: 'choice',
        group: 'style',
        label: 'Stroke width',
        value: '3.5',
        options: [
          { value: '2', label: '2 px' },
          { value: '3.5', label: '3.5 px' },
          { value: '6', label: '6 px' },
        ],
      });
      expect(byId.get('notebook.eraser-radius')).toBeUndefined();
      expect(
        handle.tools!.execute('notebook.tool.froglight.ink.eraser.precision'),
      ).toBe(true);
      const precisionSize = handle
        .tools!.snapshot()
        .controls.find((control) => control.id === 'notebook.eraser-radius');
      expect(precisionSize).toMatchObject({
        kind: 'range',
        min: 2,
        max: 40,
        step: 1,
      });
    } finally {
      handle.destroy();
    }
  });

  it('keeps pager controls provider-local alongside the surface subset', () => {
    const handle = mount();
    try {
      const ids = handle
        .tools!.snapshot()
        .controls.map((control) => (control as { id: string }).id);
      for (const id of [
        'notebook.previous',
        'notebook.page',
        'notebook.next',
        'notebook.template',
        'notebook.add',
        'notebook.duplicate',
        'notebook.delete',
        'notebook.insert-pdf-before',
        'notebook.insert-pdf-after',
        'notebook.fit',
        'notebook.export',
        'notebook.export-all',
        'notebook.page-width',
        'notebook.page-height',
      ]) {
        expect(ids).toContain(id);
      }
      const byId = new Map(
        handle
          .tools!.snapshot()
          .controls.map((control) => [
            (control as { id: string }).id,
            control as unknown as Record<string, unknown>,
          ]),
      );
      expect(byId.get('notebook.page')).toMatchObject({
        kind: 'status',
        label: '1 / 1',
      });
      expect(byId.get('notebook.zoom')).toMatchObject({
        kind: 'number',
        label: 'Notebook zoom',
        value: 100,
        min: 25,
        max: 800,
      });
    } finally {
      handle.destroy();
    }
  });

  it('disables stack zoom honestly when no pages exist', () => {
    const handle = mount(emptyNotebook('Empty golden'));
    try {
      const byId = new Map(
        handle
          .tools!.snapshot()
          .controls.map((control) => [
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
      handle.destroy();
    }
  });

  it('routes surface commands through execute and rejects unknown ids', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      // trio: Stroke eraser over the single engine.
      expect(tools.execute('notebook.tool.froglight.ink.eraser.stroke')).toBe(
        true,
      );
      expect(tools.execute('notebook.color', '#a08430')).toBe(true);
      expect(tools.execute('notebook.width', '5')).toBe(true);
      expect(tools.execute('notebook.eraser-radius', '12')).toBe(true);
      expect(tools.execute('notebook.zoom-slider', '150')).toBe(true);
      const byId = new Map(
        tools
          .snapshot()
          .controls.map((control) => [
            (control as { id: string }).id,
            control as unknown as Record<string, unknown>,
          ]),
      );
      expect(byId.get('notebook.color')).toMatchObject({ value: '#a08430' });
      expect(byId.get('notebook.width')).toMatchObject({ value: '5' });
      expect(byId.get('notebook.nope')).toBeUndefined();
      expect(tools.execute('notebook.nope')).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('exposes slice 10 paper, size, and ruler controls', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      const ids = tools
        .snapshot()
        .controls.map((control) => (control as { id: string }).id);
      for (const id of [
        'notebook.go-to-page',
        'notebook.paper-spacing',
        'notebook.paper-color',
        'notebook.paper-reset',
        'notebook.page-size-preset',
        'notebook.orientation',
        'notebook.ruler',
        'notebook.ruler-angle',
        'notebook.ruler-center',
      ]) {
        expect(ids).toContain(id);
      }
      // Cornell joins the paper choice without replacing the core set.
      const template = tools
        .snapshot()
        .controls.find(
          (control) => (control as { id: string }).id === 'notebook.template',
        ) as unknown as {
        options: { value: string }[];
      };
      expect(template.options.map((option) => option.value)).toContain(
        'froglight.cornell',
      );
      // Paper spacing round-trips through the pager into canonical state.
      expect(tools.execute('notebook.paper-spacing', '64')).toBe(true);
      const byId = () =>
        new Map(
          tools
            .snapshot()
            .controls.map((control) => [
              (control as { id: string }).id,
              control as unknown as Record<string, unknown>,
            ]),
        );
      expect(byId().get('notebook.paper-spacing')).toMatchObject({
        value: 64,
      });
      expect(tools.execute('notebook.paper-color', '#faf7ef')).toBe(true);
      expect(byId().get('notebook.paper-color')).toMatchObject({
        value: '#faf7ef',
      });
      expect(tools.execute('notebook.paper-reset')).toBe(true);
      expect(byId().get('notebook.paper-spacing')).toMatchObject({
        value: 44,
      });
      // Ruler toggles ephemerally: active state flips without new pages.
      expect(byId().get('notebook.ruler')).toMatchObject({ active: false });
      expect(tools.execute('notebook.ruler')).toBe(true);
      expect(byId().get('notebook.ruler')).toMatchObject({ active: true });
      expect(tools.execute('notebook.ruler-angle', '30')).toBe(true);
      expect(byId().get('notebook.ruler-angle')).toMatchObject({ value: 30 });
      expect(tools.execute('notebook.ruler')).toBe(true);
      expect(byId().get('notebook.ruler')).toMatchObject({ active: false });
      // Size preset + orientation resize the current page.
      expect(
        tools.execute('notebook.page-size-preset', 'froglight.square'),
      ).toBe(true);
      // Go-to-page clamps through the pager jump (no throw on range).
      expect(tools.execute('notebook.go-to-page', '1')).toBe(true);
      expect(tools.execute('notebook.orientation', 'portrait')).toBe(true);
    } finally {
      handle.destroy();
    }
  });
});
