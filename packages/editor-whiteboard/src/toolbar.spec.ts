// @vitest-environment jsdom
/**
 * Golden characterization of the Whiteboard Document Tools snapshot
 * (problem 6). Pins the current toolbar contract through the
 * provider-neutral seam so the shared surface toolbar builder refactor
 * cannot silently rename controls, regroup them, or change value semantics.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptySurface,
  infiniteFrame,
  textObject,
  textRoleOf,
  type SurfaceModel,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { WhiteboardDocumentEditorProvider } from './editor.js';

describe('whiteboard toolbar golden', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  function mount(model: SurfaceModel = emptySurface(infiniteFrame())) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    return new WhiteboardDocumentEditorProvider().createEditor({
      session: {
        model,
        markDirty: () => undefined,
      } as never,
      parent,
    });
  }

  function pointer(
    type: string,
    id: number,
    x: number,
    y: number,
  ): PointerEvent {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    }) as unknown as PointerEvent;
    Object.defineProperty(event, 'pointerId', { value: id });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    Object.defineProperty(event, 'pressure', { value: 0.5 });
    return event;
  }

  it('exposes pen, select, text/card, shapes, style, and zoom in a stable order', () => {
    const handle = mount();
    try {
      const snapshot = handle.tools!.snapshot();
      expect(snapshot.context).toBe('Whiteboard');
      expect(
        snapshot.controls.map((control) => (control as { id: string }).id),
      ).toEqual([
        // canonical family order: Write pens, two Erasers,
        // Select pair, Shapes trio, Text — identical across Ink/Notebook/
        // Whiteboard (single eraser replaced; `surface.erase.tool` stays
        // dormant, never renamed) — then the Whiteboard-only Card addition
        // and shared image insertion.
        'whiteboard.tool.pen',
        'whiteboard.tool.fountain',
        'whiteboard.tool.brush',
        'whiteboard.tool.pencil',
        'whiteboard.tool.highlighter',
        'whiteboard.tool.eraser-stroke',
        'whiteboard.tool.eraser-precision',
        'whiteboard.tool.select',
        'whiteboard.tool.lasso',
        'whiteboard.tool.line',
        'whiteboard.tool.rect',
        'whiteboard.tool.ellipse',
        'whiteboard.tool.triangle',
        'whiteboard.tool.diamond',
        'whiteboard.tool.text',
        'whiteboard.tool.card',
        'whiteboard.image',
        'whiteboard.selection.align',
        'whiteboard.selection.distribute',
        'whiteboard.selection.order',
        'whiteboard.selection.lock',
        'whiteboard.selection.unlock',
        'whiteboard.selection.group',
        'whiteboard.selection.ungroup',
        'whiteboard.selection.duplicate',
        'whiteboard.selection.delete',
        'whiteboard.selection.connect',
        'whiteboard.text.style',
        'whiteboard.text.size',
        'whiteboard.text.bold',
        'whiteboard.text.italic',
        'whiteboard.text.align',
        'whiteboard.text.color',
        'whiteboard.text.wrap',
        'whiteboard.color',
        'whiteboard.width',
        'whiteboard.zoom-out',
        'whiteboard.zoom-reset',
        'whiteboard.zoom',
        'whiteboard.zoom-slider',
        'whiteboard.zoom-in',
        'whiteboard.fit',
        'whiteboard.canvas-mode',
        'whiteboard.paper-template',
        'whiteboard.paper-spacing',
        'whiteboard.paper-color',
        'whiteboard.paper-reset',
        // Second-tap settings (slice 8): active-tool schema, unplaced.
        'whiteboard.settings.pen.saved-style',
        'whiteboard.settings.pen.save-style',
        'whiteboard.settings.pen.type',
        'whiteboard.settings.pen.size',
        'whiteboard.settings.pen.color',
        'whiteboard.settings.pen.pressure',
        'whiteboard.settings.pen.pressure-min',
        'whiteboard.settings.pen.pressure-max',
        'whiteboard.settings.pen.stabilization',
        'whiteboard.settings.pen.streamline',
        // conditional props: ball pen keeps pressure/smoothing/
        // end-taper only (fixed round nib, no tilt/velocity semantics).
        'whiteboard.settings.pen.taper-end',
        'whiteboard.settings.pen.gesture-draw-hold',
        'whiteboard.settings.pen.gesture-scribble',
        'whiteboard.settings.pen.gesture-circle',
      ]);
    } finally {
      handle.destroy();
    }
  });

  it('shares the family draw group with live active state', () => {
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
      expect(byId.get('whiteboard.tool.pen')).toMatchObject({
        kind: 'button',
        group: 'draw',
        label: 'Pen',
        active: true,
      });
      // one shared draw group across the family — no per-family
      // taxonomy (select/erase/shapes/connect splits) on shared tools.
      for (const id of [
        'whiteboard.tool.fountain',
        'whiteboard.tool.brush',
        'whiteboard.tool.pencil',
        'whiteboard.tool.highlighter',
        'whiteboard.tool.eraser-stroke',
        'whiteboard.tool.eraser-precision',
        'whiteboard.tool.select',
        'whiteboard.tool.lasso',
        'whiteboard.tool.line',
        'whiteboard.tool.rect',
        'whiteboard.tool.ellipse',
        'whiteboard.tool.triangle',
        'whiteboard.tool.diamond',
        'whiteboard.tool.text',
      ]) {
        expect(byId.get(id)).toMatchObject({ group: 'draw' });
      }
      expect(byId.get('whiteboard.tool.select')).toMatchObject({
        active: false,
      });
      expect(byId.get('whiteboard.tool.highlighter')).toMatchObject({
        label: 'Highlighter',
        icon: 'highlighter',
      });
      expect(byId.get('whiteboard.tool.text')).toMatchObject({
        group: 'draw',
        label: 'Text',
      });
      expect(byId.get('whiteboard.tool.card')).toMatchObject({
        group: 'insert',
        label: 'Card',
        icon: 'blocks',
      });
      expect(byId.get('whiteboard.tool.rect')).toMatchObject({
        label: 'Rectangle',
        icon: 'rect',
      });
      // One line tool under its own id and shared label: no separate Arrow
      // entry and no whiteboard-only Connector rename.
      expect(byId.get('whiteboard.tool.line')).toMatchObject({
        group: 'draw',
        label: 'Line',
        icon: 'arrow-line',
      });
      expect(byId.has('whiteboard.tool.arrow')).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('exposes arrange controls disabled without a selection', () => {
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
      expect(byId.get('whiteboard.selection.align')).toMatchObject({
        kind: 'choice',
        group: 'arrange',
        disabled: true,
      });
      expect(byId.get('whiteboard.selection.connect')).toMatchObject({
        kind: 'button',
        group: 'arrange',
        disabled: true,
      });
      expect(byId.get('whiteboard.selection.duplicate')).toMatchObject({
        kind: 'button',
        group: 'arrange',
        disabled: true,
      });
    } finally {
      handle.destroy();
    }
  });

  it('routes arrange commands to the selection verbs', () => {
    const handle = mount();
    try {
      const canvas = document.querySelector('canvas')!;
      const tools = handle.tools!;
      expect(tools.execute('whiteboard.tool.pen')).toBe(true);
      const stroke = (id: number, y: number) => {
        canvas.dispatchEvent(pointer('pointerdown', id, 10, y));
        canvas.dispatchEvent(pointer('pointermove', id, 30, y));
        canvas.dispatchEvent(pointer('pointerup', id, 30, y));
      };
      stroke(1, 10);
      stroke(2, 30);
      expect(tools.execute('whiteboard.tool.lasso')).toBe(true);
      canvas.dispatchEvent(pointer('pointerdown', 3, 5, 5));
      canvas.dispatchEvent(pointer('pointermove', 3, 40, 5));
      canvas.dispatchEvent(pointer('pointermove', 3, 40, 40));
      canvas.dispatchEvent(pointer('pointerup', 3, 5, 40));
      // Align tops, then duplicate, then connect the pair.
      expect(tools.execute('whiteboard.selection.align', 'top')).toBe(true);
      expect(tools.execute('whiteboard.selection.duplicate')).toBe(true);
      expect(tools.execute('whiteboard.selection.connect')).toBe(true);
      // Unknown arrange values resolve to false without mutating.
      expect(tools.execute('whiteboard.selection.align', 'diagonal')).toBe(
        false,
      );
    } finally {
      handle.destroy();
    }
  });

  it('routes second-tap settings actions into tool presets', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      expect(tools.execute('whiteboard.tool.pen')).toBe(true);
      // Size and color write into the pen preset; the color joins MRU.
      expect(tools.execute('whiteboard.settings.pen.size', '6')).toBe(true);
      expect(tools.execute('whiteboard.settings.pen.color', '#c4554d')).toBe(
        true,
      );
      // eraser mode rides the toolbar tools, never a settings
      // dropdown — legacy writes resolve false (never a crash). Selecting
      // the Precision tool pins the mode end-to-end.
      expect(tools.execute('whiteboard.tool.eraser-stroke')).toBe(true);
      expect(tools.execute('whiteboard.settings.eraser.mode', 'unknown')).toBe(
        false,
      );
      expect(tools.execute('whiteboard.tool.eraser-precision')).toBe(true);
      expect(tools.execute('whiteboard.settings.eraser.mode', 'vaporize')).toBe(
        false,
      );
      expect(tools.execute('whiteboard.tool.highlighter')).toBe(true);
      expect(tools.execute('whiteboard.settings.highlighter.straight')).toBe(
        true,
      );
      // Unknown settings ids resolve to false without mutating.
      expect(tools.execute('whiteboard.settings.pen.nope', '6')).toBe(false);
      expect(tools.execute('ink.settings.pen.size', '6')).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('exposes compact style controls and the zoom cluster', () => {
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
      expect(byId.get('whiteboard.color')).toMatchObject({
        kind: 'color',
        group: 'style',
        label: 'Stroke color',
        value: '#37352f',
        options: ['#37352f', '#7c6cf0', '#c4554d', '#448361', '#a08430'],
      });
      expect(byId.get('whiteboard.width')).toMatchObject({
        kind: 'choice',
        group: 'style',
        label: 'Stroke width',
        value: '3.5',
      });
      expect(byId.get('whiteboard.eraser-radius')).toBeUndefined();
      expect(handle.tools!.execute('whiteboard.tool.eraser-precision')).toBe(
        true,
      );
      const precisionSize = handle
        .tools!.snapshot()
        .controls.find((control) => control.id === 'whiteboard.eraser-radius');
      expect(precisionSize).toMatchObject({
        kind: 'range',
        group: 'style',
        min: 2,
        max: 40,
        step: 1,
      });
      expect(byId.get('whiteboard.zoom')).toMatchObject({
        kind: 'number',
        min: 25,
        max: 800,
        step: 1,
        suffix: '%',
      });
      expect(byId.get('whiteboard.zoom-slider')).toMatchObject({
        kind: 'range',
        min: 25,
        max: 800,
        step: 5,
      });
      // Mount fits the camera to the host element, so the initial percentage
      // is environment-dependent; the reset label must track the live value.
      const reset = byId.get('whiteboard.zoom-reset') as {
        shortLabel: string;
        label: string;
      };
      expect(reset.shortLabel).toMatch(/^\d+%$/);
      expect(reset.label).toContain(reset.shortLabel);
      expect(byId.get('whiteboard.zoom')).toMatchObject({
        value: Number(reset.shortLabel.replace('%', '')),
      });
    } finally {
      handle.destroy();
    }
  });

  it('routes shared commands through execute and rejects unknown ids', () => {
    const handle = mount();
    try {
      const tools = handle.tools!;
      expect(tools.execute('whiteboard.tool.card')).toBe(true);
      const card = tools
        .snapshot()
        .controls.find(
          (control) =>
            (control as { id: string }).id === 'whiteboard.tool.card',
        ) as unknown as { active?: boolean };
      expect(card.active).toBe(true);
      expect(tools.execute('whiteboard.color', '#448361')).toBe(true);
      expect(tools.execute('whiteboard.width', '6')).toBe(true);
      expect(tools.execute('whiteboard.zoom-slider', '150')).toBe(true);
      expect(tools.execute('whiteboard.fit')).toBe(true);
      expect(tools.execute('whiteboard.nope')).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('leaves the retired arrow alias unresolvable', () => {
    const handle = mount();
    try {
      // The shared line tool is the single arrowed line tool; no hidden
      // alias may resolve to it.
      expect(handle.tools!.execute('whiteboard.tool.arrow')).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('exposes editable text defaults without a text selection', () => {
    const handle = mount();
    try {
      const controls = handle.tools!.snapshot().controls;
      const ids = controls.map((control) => (control as { id: string }).id);
      // shared builder: no text selected, so the text group is
      // omitted — `surface.text.*` composition items stay unresolved and
      // no `surface.text.*` semantic role leaks into the snapshot.
      // `froglight.card` text stays distinct (unstyled here).
      for (const id of [
        'whiteboard.text.style',
        'whiteboard.text.size',
        'whiteboard.text.bold',
        'whiteboard.text.italic',
        'whiteboard.text.align',
        'whiteboard.text.color',
        'whiteboard.text.wrap',
      ]) {
        expect(ids).toContain(id);
      }
      expect(
        controls.filter((control) => control.group === 'text'),
      ).toHaveLength(7);
      expect(handle.tools!.execute('whiteboard.text.style', 'h1')).toBe(true);
      expect(handle.tools!.execute('whiteboard.text.bold')).toBe(true);
      expect(handle.tools!.execute('ink.text.bold')).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('exposes grouped surface text with the shared presentation when text is selected', () => {
    const model = emptySurface(infiniteFrame()) as SurfaceModel;
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
          ids.indexOf('whiteboard.text.style'),
          ids.indexOf('whiteboard.text.style') + 7,
        ),
      ).toEqual([
        'whiteboard.text.style',
        'whiteboard.text.size',
        'whiteboard.text.bold',
        'whiteboard.text.italic',
        'whiteboard.text.align',
        'whiteboard.text.color',
        'whiteboard.text.wrap',
      ]);
      const byId = new Map(
        controls.map((control) => [
          (control as { id: string }).id,
          control as unknown as Record<string, unknown>,
        ]),
      );
      expect(byId.get('whiteboard.text.style')).toMatchObject({
        kind: 'choice',
        group: 'text',
        label: 'Text style',
        icon: 'heading',
        value: 'body',
        semanticRole: 'surface.text.style',
      });
      expect(byId.get('whiteboard.text.bold')).toMatchObject({
        kind: 'button',
        group: 'text',
        label: 'Bold',
        semanticRole: 'surface.text.bold',
        activationRole: 'toggle',
      });
      expect(byId.get('whiteboard.text.align')).toMatchObject({
        kind: 'choice',
        group: 'text',
        value: 'start',
        semanticRole: 'surface.text.align',
      });
      expect(byId.get('whiteboard.text.size')).toMatchObject({
        kind: 'number',
        group: 'text',
        label: 'Font size',
        value: 16,
        semanticRole: 'surface.text.size',
      });
      expect(byId.get('whiteboard.text.color')).toMatchObject({
        kind: 'color',
        group: 'text',
        label: 'Text color',
        value: '#37352f',
        semanticRole: 'surface.text.color',
      });
      expect(byId.get('whiteboard.text.wrap')).toMatchObject({
        group: 'text',
        semanticRole: 'surface.text.wrap',
        activationRole: 'toggle',
      });
    } finally {
      handle.destroy();
    }
  });

  it('routes grouped surface-text ids through the shared write path (card text distinct)', () => {
    const model = emptySurface(infiniteFrame()) as SurfaceModel;
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
      expect(tools.execute('whiteboard.text.style', 'h1')).toBe(true);
      expect(textRoleOf(model.objects['t1']!)).toBe('heading');
      expect(model.objects['t1']!.size).toBe(24);
      expect(tools.execute('whiteboard.text.bold')).toBe(true);
      expect(
        (model.objects['t1']! as unknown as Record<string, unknown>).appearance,
      ).toMatchObject({ bold: true });
      expect(tools.execute('whiteboard.text.align', 'center')).toBe(true);
      expect(tools.execute('whiteboard.text.wrap')).toBe(true);
      expect(
        (model.objects['t1']! as unknown as Record<string, unknown>).appearance,
      ).toMatchObject({ align: 'center', wrapWidth: 240 });
      // H3 writes heading + 18; the size stepper and color write explicitly.
      expect(tools.execute('whiteboard.text.style', 'h3')).toBe(true);
      expect(textRoleOf(model.objects['t1']!)).toBe('heading');
      expect(model.objects['t1']!.size).toBe(18);
      expect(tools.execute('whiteboard.text.size', '24')).toBe(true);
      expect(model.objects['t1']!.size).toBe(24);
      expect(tools.execute('whiteboard.text.color', '#c4554d')).toBe(true);
      expect(model.objects['t1']!.color).toBe('#c4554d');
      // Unknown values never mutate; cross-dialect ids never resolve.
      expect(tools.execute('whiteboard.text.style', 'h4')).toBe(false);
      expect(tools.execute('whiteboard.text.align', 'justify')).toBe(false);
      expect(tools.execute('ink.text.bold')).toBe(false);
      expect(tools.execute('notebook.text.bold')).toBe(false);
      // Body drops the heading (outline-excluded) leaving size alone.
      (
        handle as unknown as {
          setSelectionForTest(ids: readonly string[]): void;
        }
      ).setSelectionForTest(['t1']);
      expect(tools.execute('whiteboard.text.style', 'body')).toBe(true);
      expect(textRoleOf(model.objects['t1']!)).toBe('body');
      expect(model.objects['t1']!.size).toBe(24);
    } finally {
      handle.destroy();
    }
  });

  it('commits a typed card through the card tool gesture', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = emptySurface(infiniteFrame()) as SurfaceModel;
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session: { model, markDirty: () => undefined } as never,
      parent,
    });
    try {
      expect(handle.tools!.execute('whiteboard.tool.card')).toBe(true);
      const canvas = parent.querySelector('canvas')!;
      canvas.dispatchEvent(pointer('pointerdown', 1, 100, 100));
      canvas.dispatchEvent(pointer('pointermove', 1, 300, 220));
      canvas.dispatchEvent(pointer('pointerup', 1, 300, 220));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve(undefined)),
      );
      expect(model.order).toHaveLength(1);
      const card = model.objects[model.order[0]!] as unknown as Record<
        string,
        unknown
      >;
      expect(card).toMatchObject({
        type: 'froglight.card',
        text: 'New card',
      });
      expect(card.width as number).toBeGreaterThanOrEqual(40);
      expect(card.height as number).toBeGreaterThanOrEqual(32);
    } finally {
      handle.destroy();
    }
  });

  it('drops a default card on tap', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = emptySurface(infiniteFrame()) as SurfaceModel;
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session: { model, markDirty: () => undefined } as never,
      parent,
    });
    try {
      expect(handle.tools!.execute('whiteboard.tool.card')).toBe(true);
      const canvas = parent.querySelector('canvas')!;
      canvas.dispatchEvent(pointer('pointerdown', 1, 50, 50));
      canvas.dispatchEvent(pointer('pointerup', 1, 50, 50));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve(undefined)),
      );
      expect(model.order).toHaveLength(1);
      expect(
        model.objects[model.order[0]!] as unknown as Record<string, unknown>,
      ).toMatchObject({
        type: 'froglight.card',
        width: 200,
        height: 120,
      });
    } finally {
      handle.destroy();
    }
  });
});
