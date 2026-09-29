import { describe, expect, it } from 'vitest';
import type { DocumentToolSnapshot } from '@froglight/foundation';
import { StylusPreferredActionController } from './stylus-preferred-action.js';

const PEN = 'ink.tool.froglight.ink.pen';
const ERASER = 'ink.tool.froglight.ink.eraser';
const MARKER = 'ink.tool.froglight.ink.highlighter';

function button(id: string, active = false): DocumentToolSnapshot['controls'][number] {
  return { kind: 'button', id, group: 'draw', label: id, ...(active ? { active: true } : {}) };
}

function snapshot(activeId: string): DocumentToolSnapshot {
  return { context: 'Ink canvas', controls: [button(PEN, activeId === PEN), button(MARKER, activeId === MARKER), button(ERASER, activeId === ERASER)] };
}

describe('StylusPreferredActionController', () => {
  it('ignore/unknown/undefined are no-ops', () => {
    const controller = new StylusPreferredActionController();
    for (const action of [undefined, 'ignore', 'unknown'] as const) {
      expect(controller.routeDoubleTap(action, 'main', snapshot(PEN)).kind).toBe('noop');
    }
  });

  it('switchEraser toggles persistently pen → eraser → previous', () => {
    const controller = new StylusPreferredActionController();
    const first = controller.routeDoubleTap('switchEraser', 'main', snapshot(PEN));
    expect(first).toEqual({ kind: 'switchTool', pane: 'main', id: ERASER });
    // Second tap while on the eraser restores the previous tool.
    const second = controller.routeDoubleTap('switchEraser', 'main', snapshot(ERASER));
    expect(second).toEqual({ kind: 'switchTool', pane: 'main', id: PEN });
  });

  it('switchPrevious follows tool history, never undo history', () => {
    const controller = new StylusPreferredActionController();
    controller.noteSnapshot('main', snapshot(PEN));
    controller.noteSnapshot('main', snapshot(MARKER));
    const intent = controller.routeDoubleTap('switchPrevious', 'main', snapshot(MARKER));
    expect(intent).toEqual({ kind: 'switchTool', pane: 'main', id: PEN });
  });

  it('never restores a tool that no longer exists', () => {
    const controller = new StylusPreferredActionController();
    controller.noteSnapshot('main', snapshot(PEN));
    const gone: DocumentToolSnapshot = {
      context: 'Ink canvas',
      controls: [button(MARKER, true)],
    };
    expect(controller.routeDoubleTap('switchPrevious', 'main', gone).kind).toBe('noop');
  });

  it('palette actions map to focus modes; shortcut is diagnostics-only', () => {
    const controller = new StylusPreferredActionController();
    expect(controller.routeDoubleTap('showColorPalette', 'main', snapshot(PEN))).toEqual({
      kind: 'openPalette',
      focusMode: 'color',
    });
    expect(controller.routeDoubleTap('showInkAttributes', 'main', snapshot(PEN))).toEqual({
      kind: 'openPalette',
      focusMode: 'attributes',
    });
    expect(controller.routeDoubleTap('showContextualPalette', 'main', snapshot(PEN))).toEqual({
      kind: 'openPalette',
      focusMode: 'full',
    });
    const shortcut = controller.routeDoubleTap('runSystemShortcut', 'main', snapshot(PEN));
    expect(shortcut.kind).toBe('diagnostic');
    expect(controller.diagnostics.length).toBe(1);
  });

  it('does nothing without a surface snapshot or eraser', () => {
    const controller = new StylusPreferredActionController();
    expect(controller.routeDoubleTap('switchEraser', null, snapshot(PEN)).kind).toBe('noop');
    expect(
      controller.routeDoubleTap('switchEraser', 'main', {
        context: 'Paragraph',
        controls: [button('markdown.bold', true)],
      }).kind,
    ).toBe('noop');
  });
});

describe('squeeze absolute toggle (NO-BYPASS)', () => {
  it('routeSqueezeEnded never routes execution for any preferred action', () => {
    const controller = new StylusPreferredActionController();
    const snap = snapshot(PEN);
    for (const action of [
      'switchEraser',
      'switchPrevious',
      'ignore',
      'unknown',
      'runSystemShortcut',
      'showColorPalette',
      'showInkAttributes',
      'showContextualPalette',
      undefined,
    ] as const) {
      expect(controller.routeSqueezeEnded(action, 'main', snap).kind).toBe(
        'noop',
      );
    }
  });

  it('routeDoubleTap keeps separate persistent semantics', () => {
    const controller = new StylusPreferredActionController();
    expect(
      controller.routeDoubleTap('switchEraser', 'main', snapshot(PEN)),
    ).toEqual({ kind: 'switchTool', pane: 'main', id: ERASER });
  });
});
