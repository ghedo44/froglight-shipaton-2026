// @vitest-environment jsdom
/**
 * Golden characterization of the Ink Document Tools snapshot (problem 6).
 * Pins the current toolbar contract through the provider-neutral seam so the
 * shared surface toolbar builder refactor cannot silently rename controls,
 * regroup them, or change value semantics.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  textObject,
  textRoleOf,
  type SurfaceModel,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { InkDocumentEditorProvider } from '../editor.js';

describe('ink toolbar golden', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  function mount(model = emptySurface(boundedFrame(800, 600))) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = new InkDocumentEditorProvider().createEditor({
      session: {
        model,
        markDirty: () => undefined,
      } as never,
      parent,
    });
    return handle;
  }

  it('exposes draw, style, zoom, fit, export, and frame controls in a stable order', () => {
    const handle = mount();
    try {
      const snapshot = handle.tools!.snapshot();
      expect(snapshot.context).toBe('Ink canvas');
      expect(
        snapshot.controls.map((control) => (control as { id: string }).id),
      ).toEqual([
        // canonical family order: Write pens, two Erasers,
        // Select pair, Shapes trio, Text — identical across Ink/Notebook/
        // Whiteboard (single eraser replaced; `surface.erase.tool` stays
        // dormant for overrides/old hosts).
        'ink.tool.froglight.ink.pen',
        'ink.tool.froglight.ink.fountain',
        'ink.tool.froglight.ink.brush',
        'ink.tool.froglight.ink.pencil',
        'ink.tool.froglight.ink.highlighter',
        'ink.tool.froglight.ink.eraser.stroke',
        'ink.tool.froglight.ink.eraser.precision',
        'ink.tool.froglight.ink.select',
        'ink.tool.froglight.ink.lasso',
        'ink.tool.froglight.ink.line',
        'ink.tool.froglight.ink.rect',
        'ink.tool.froglight.ink.ellipse',
        'ink.tool.froglight.ink.triangle',
        'ink.tool.froglight.ink.diamond',
        'ink.tool.froglight.ink.text',
        'ink.selection.align',
        'ink.selection.distribute',
        'ink.selection.order',
        'ink.selection.lock',
        'ink.selection.unlock',
        'ink.selection.group',
        'ink.selection.ungroup',
        'ink.selection.duplicate',
        'ink.selection.delete',
        'ink.selection.connect',
        'ink.text.style',
        'ink.text.size',
        'ink.text.bold',
        'ink.text.italic',
        'ink.text.align',
        'ink.text.color',
        'ink.text.wrap',
        'ink.image',
        'ink.color',
        'ink.width',
        'ink.zoom-out',
        'ink.zoom-reset',
        'ink.zoom',
        'ink.zoom-slider',
        'ink.zoom-in',
        'ink.fit',
        'ink.paper-template',
        'ink.paper-spacing',
        'ink.paper-color',
        'ink.paper-reset',
        'ink.export',
        'ink.frame-width',
        'ink.frame-height',
        // Second-tap settings (slice 8): active-tool schema, unplaced.
        'ink.settings.pen.saved-style',
        'ink.settings.pen.save-style',
        'ink.settings.pen.type',
        'ink.settings.pen.size',
        'ink.settings.pen.color',
        'ink.settings.pen.pressure',
        'ink.settings.pen.pressure-min',
        'ink.settings.pen.pressure-max',
        'ink.settings.pen.stabilization',
        'ink.settings.pen.streamline',
        // conditional props: ball pen keeps pressure/smoothing/
        // end-taper only (fixed round nib, no tilt/velocity semantics).
        'ink.settings.pen.taper-end',
        'ink.settings.pen.gesture-draw-hold',
        'ink.settings.pen.gesture-scribble',
        'ink.settings.pen.gesture-circle',
      ]);
    } finally {
      handle.destroy();
    }
  });

  it('keeps draw tools in one group with live active state and icons', () => {
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
      for (const id of [
        'ink.tool.froglight.ink.select',
        'ink.tool.froglight.ink.pen',
        'ink.tool.froglight.ink.highlighter',
        'ink.tool.froglight.ink.eraser.stroke',
        'ink.tool.froglight.ink.eraser.precision',
        'ink.tool.froglight.ink.lasso',
        'ink.tool.froglight.ink.rect',
        'ink.tool.froglight.ink.ellipse',
        'ink.tool.froglight.ink.triangle',
        'ink.tool.froglight.ink.diamond',
        'ink.tool.froglight.ink.line',
        'ink.tool.froglight.ink.text',
      ]) {
        expect(byId.get(id)).toMatchObject({ kind: 'button', group: 'draw' });
      }
      // The surface engine starts on the pen tool.
      expect(byId.get('ink.tool.froglight.ink.pen')).toMatchObject({
        active: true,
      });
      expect(byId.get('ink.tool.froglight.ink.select')).toMatchObject({
        active: false,
      });
      expect(byId.get('ink.tool.froglight.ink.line')).toMatchObject({
        label: 'Line',
        icon: 'arrow-line',
      });
    } finally {
      handle.destroy();
    }
  });

  it('exposes style controls with shared swatches, widths, and eraser range', () => {
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
      expect(byId.get('ink.color')).toMatchObject({
        kind: 'color',
        group: 'style',
        label: 'Stroke color',
        value: '#37352f',
        options: ['#37352f', '#7c6cf0', '#c4554d', '#448361', '#a08430'],
      });
      expect(byId.get('ink.width')).toMatchObject({
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
      expect(byId.get('ink.eraser-radius')).toBeUndefined();
      expect(
        handle.tools!.execute('ink.tool.froglight.ink.eraser.precision'),
      ).toBe(true);
      const precisionSize = handle
        .tools!.snapshot()
        .controls.find((control) => control.id === 'ink.eraser-radius');
      expect(precisionSize).toMatchObject({
        kind: 'range',
        group: 'style',
        label: 'Eraser size',
        min: 2,
        max: 40,
        step: 1,
      });
    } finally {
      handle.destroy();
    }
  });

  it('exposes the zoom cluster with live percentage and 25-800 range', () => {
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
      // Mount fits the camera to the host element, so the initial percentage
      // is environment-dependent; the cluster must stay internally consistent.
      const reset = byId.get('ink.zoom-reset') as {
        shortLabel: string;
        label: string;
      };
      expect(reset.shortLabel).toMatch(/^\d+%$/);
      expect(reset.label).toContain(reset.shortLabel);
      const current = Number(reset.shortLabel.replace('%', ''));
      expect(byId.get('ink.zoom')).toMatchObject({
        kind: 'number',
        group: 'view',
        label: 'Zoom',
        value: current,
        min: 25,
        max: 800,
        step: 1,
        suffix: '%',
      });
      expect(byId.get('ink.zoom-slider')).toMatchObject({
        kind: 'range',
        group: 'view',
        value: current,
        min: 25,
        max: 800,
        step: 5,
      });
      expect(handle.tools!.execute('ink.zoom-reset')).toBe(true);
      expect(
        handle
          .tools!.snapshot()
          .controls.find(
            (control) => (control as { id: string }).id === 'ink.zoom',
          ),
      ).toMatchObject({ value: 100 });
    } finally {
      handle.destroy();
    }
  });

  it('routes shared commands through execute and rejects unknown ids', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      expect(tools.execute('ink.tool.froglight.ink.rect')).toBe(true);
      const byId = new Map(
        tools
          .snapshot()
          .controls.map((control) => [
            (control as { id: string }).id,
            control as unknown as Record<string, unknown>,
          ]),
      );
      expect(byId.get('ink.tool.froglight.ink.rect')).toMatchObject({
        active: true,
      });
      expect(tools.execute('ink.color', '#c4554d')).toBe(true);
      expect(tools.execute('ink.width', '6')).toBe(true);
      expect(tools.execute('ink.eraser-radius', '20')).toBe(true);
      expect(tools.execute('ink.tool.froglight.ink.eraser.precision')).toBe(
        true,
      );
      expect(tools.execute('ink.zoom-slider', '150')).toBe(true);
      const after = new Map(
        tools
          .snapshot()
          .controls.map((control) => [
            (control as { id: string }).id,
            control as unknown as Record<string, unknown>,
          ]),
      );
      expect(after.get('ink.color')).toMatchObject({ value: '#c4554d' });
      expect(after.get('ink.width')).toMatchObject({ value: '6' });
      expect(after.get('ink.eraser-radius')).toMatchObject({ value: 20 });
      expect(after.get('ink.zoom')).toMatchObject({ value: 150 });
      expect(tools.execute('ink.nope')).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('exposes text defaults before placement and updates them without dirtying content', () => {
    const handle = mount();
    try {
      const controls = handle.tools!.snapshot().controls;
      const ids = controls.map((control) => (control as { id: string }).id);
      // Choosing Text must reveal formatting before the first object exists.
      for (const id of [
        'ink.text.style',
        'ink.text.size',
        'ink.text.bold',
        'ink.text.italic',
        'ink.text.align',
        'ink.text.color',
        'ink.text.wrap',
      ]) {
        expect(ids).toContain(id);
      }
      expect(
        controls.filter((control) => control.group === 'text'),
      ).toHaveLength(7);
      expect(handle.tools!.execute('ink.text.style', 'h1')).toBe(true);
      expect(handle.tools!.execute('ink.text.bold')).toBe(true);
      expect(handle.tools!.snapshot().controls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'ink.text.style', value: 'h1' }),
          expect.objectContaining({ id: 'ink.text.bold', active: true }),
        ]),
      );
      expect(handle.tools!.execute('notebook.text.bold')).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('exposes grouped surface text with the shared presentation when text is selected', () => {
    const model = emptySurface(boundedFrame(800, 600)) as SurfaceModel;
    const record = textObject('t1', { x: 10, y: 20, text: 'Title' });
    model.objects['t1'] = record;
    model.order.push('t1');
    const handle = mount(model);
    try {
      (
        handle as unknown as {
          setSelectionForTest(ids: readonly string[]): void;
        }
      ).setSelectionForTest(['t1']);
      const controls = handle.tools!.snapshot().controls;
      const ids = controls.map((control) => (control as { id: string }).id);
      // Canonical slot order Style, Size, Bold, Italic, Align, Color, Wrap.
      expect(
        ids.slice(
          ids.indexOf('ink.text.style'),
          ids.indexOf('ink.text.style') + 7,
        ),
      ).toEqual([
        'ink.text.style',
        'ink.text.size',
        'ink.text.bold',
        'ink.text.italic',
        'ink.text.align',
        'ink.text.color',
        'ink.text.wrap',
      ]);
      const byId = new Map(
        controls.map((control) => [
          (control as { id: string }).id,
          control as unknown as Record<string, unknown>,
        ]),
      );
      expect(byId.get('ink.text.style')).toMatchObject({
        kind: 'choice',
        group: 'text',
        label: 'Text style',
        icon: 'heading',
        value: 'body',
        semanticRole: 'surface.text.style',
      });
      expect(byId.get('ink.text.size')).toMatchObject({
        kind: 'number',
        group: 'text',
        label: 'Font size',
        value: 16,
        semanticRole: 'surface.text.size',
      });
      expect(byId.get('ink.text.bold')).toMatchObject({
        kind: 'button',
        group: 'text',
        label: 'Bold',
        semanticRole: 'surface.text.bold',
        activationRole: 'toggle',
      });
      expect(byId.get('ink.text.italic')).toMatchObject({
        group: 'text',
        semanticRole: 'surface.text.italic',
        activationRole: 'toggle',
      });
      expect(byId.get('ink.text.align')).toMatchObject({
        kind: 'choice',
        group: 'text',
        label: 'Text alignment',
        value: 'start',
        semanticRole: 'surface.text.align',
      });
      expect(byId.get('ink.text.color')).toMatchObject({
        kind: 'color',
        group: 'text',
        label: 'Text color',
        value: '#37352f',
        semanticRole: 'surface.text.color',
      });
      expect(byId.get('ink.text.wrap')).toMatchObject({
        group: 'text',
        semanticRole: 'surface.text.wrap',
        activationRole: 'toggle',
      });
    } finally {
      handle.destroy();
    }
  });

  it('routes grouped surface-text ids through the shared write path', () => {
    const model = emptySurface(boundedFrame(800, 600)) as SurfaceModel;
    const record = textObject('t1', { x: 10, y: 20, text: 'Title' });
    model.objects['t1'] = record;
    model.order.push('t1');
    const handle = mount(model);
    try {
      const tools = handle.tools!;
      (
        handle as unknown as {
          setSelectionForTest(ids: readonly string[]): void;
        }
      ).setSelectionForTest(['t1']);
      // H1 writes heading + 24 (outline feed: heading roles outline).
      expect(tools.execute('ink.text.style', 'h1')).toBe(true);
      expect(textRoleOf(model.objects['t1']!)).toBe('heading');
      expect(model.objects['t1']!.size).toBe(24);
      // Bold toggles additively; align sets verbatim; wrap uses the fixed
      // default (never measured).
      expect(tools.execute('ink.text.bold')).toBe(true);
      expect(
        (model.objects['t1']! as unknown as Record<string, unknown>).appearance,
      ).toMatchObject({ bold: true });
      expect(tools.execute('ink.text.align', 'center')).toBe(true);
      expect(
        (model.objects['t1']! as unknown as Record<string, unknown>).appearance,
      ).toMatchObject({ align: 'center' });
      expect(tools.execute('ink.text.wrap')).toBe(true);
      expect(
        (model.objects['t1']! as unknown as Record<string, unknown>).appearance,
      ).toMatchObject({ wrapWidth: 240 });
      // H3 writes heading + 18; the size stepper and color write explicitly.
      expect(tools.execute('ink.text.style', 'h3')).toBe(true);
      expect(textRoleOf(model.objects['t1']!)).toBe('heading');
      expect(model.objects['t1']!.size).toBe(18);
      expect(tools.execute('ink.text.size', '24')).toBe(true);
      expect(model.objects['t1']!.size).toBe(24);
      expect(tools.execute('ink.text.color', '#c4554d')).toBe(true);
      expect(model.objects['t1']!.color).toBe('#c4554d');
      // Unknown values never mutate; cross-dialect ids never resolve.
      expect(tools.execute('ink.text.style', 'h4')).toBe(false);
      expect(tools.execute('ink.text.align', 'justify')).toBe(false);
      expect(tools.execute('notebook.text.bold')).toBe(false);
      expect(tools.execute('whiteboard.text.bold')).toBe(false);
      // Body drops the heading (outline-excluded) leaving size alone.
      (
        handle as unknown as {
          setSelectionForTest(ids: readonly string[]): void;
        }
      ).setSelectionForTest(['t1']);
      expect(tools.execute('ink.text.style', 'body')).toBe(true);
      expect(textRoleOf(model.objects['t1']!)).toBe('body');
      expect(model.objects['t1']!.size).toBe(24);
    } finally {
      handle.destroy();
    }
  });
});
