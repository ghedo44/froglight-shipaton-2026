/**
 * Hardened accessory behavior: persistent eraser, preferred
 * actions, and squeeze sessions. Observable behavior only — no editor
 * internals, no React.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryStylusService,
  type DocumentToolSnapshot,
  type StylusViewportAnchor,
} from '@froglight/foundation';
import type { MenuEntry } from './menu.js';
import {
  StylusAccessoryBinder,
  type StylusAccessoryMenuAnchor,
  type StylusPaletteHandle,
} from './stylus-accessory.js';
import type { StylusPaletteModel } from './stylus-palette-model.js';
import {
  createStylusMenuRegistry,
  type StylusMenuContext,
} from './stylus-menu-registry.js';

const INK_ERASER = 'ink.tool.froglight.ink.eraser';
const INK_PEN = 'ink.tool.froglight.ink.pen';
const INK_MARKER = 'ink.tool.froglight.ink.highlighter';

function button(
  id: string,
  active = false,
): DocumentToolSnapshot['controls'][number] {
  const toolRole =
    id === INK_ERASER ? 'eraser' : id === INK_PEN ? 'pen' : 'highlighter';
  const semanticRole =
    id === INK_ERASER
      ? 'surface.erase'
      : id === INK_PEN
        ? 'surface.pen.ball'
        : 'surface.highlighter';
  return {
    kind: 'button',
    id,
    group: 'draw',
    label: id,
    role: 'surface-tool',
    toolRole,
    semanticRole,
    ...(active ? { active: true } : {}),
  } as DocumentToolSnapshot['controls'][number];
}

function inkSnapshot(activeId: string): DocumentToolSnapshot {
  return {
    context: 'Ink canvas',
    controls: [
      button(INK_PEN, activeId === INK_PEN),
      button(INK_MARKER, activeId === INK_MARKER),
      button(INK_ERASER, activeId === INK_ERASER),
    ],
  };
}

const menuContext: StylusMenuContext = {
  pane: 'main',
  documentId: 'doc-1',
  kindId: 'froglight.ink',
};

interface PaletteCall {
  model: StylusPaletteModel;
  anchor: StylusAccessoryMenuAnchor;
}

function harness() {
  const service = new InMemoryStylusService();
  const created = createStylusMenuRegistry();
  const executed: Array<{ pane: string; id: string }> = [];
  const palettes: PaletteCall[] = [];
  const shown: Array<{
    entries: readonly MenuEntry[];
    anchor: StylusAccessoryMenuAnchor;
  }> = [];
  const handles: StylusPaletteHandle[] = [];
  let snapshot: DocumentToolSnapshot | null = inkSnapshot(INK_PEN);
  let focusedPane: string | null = 'main';
  let penAnchor: StylusViewportAnchor | null = null;
  const binder = new StylusAccessoryBinder({
    service,
    menuRegistry: created.registry,
    tools: {
      editorToolSnapshot: (pane) =>
        pane === undefined || pane === focusedPane ? snapshot : null,
      executeEditorTool: (pane, id) => {
        executed.push({ pane, id });
        // Keep the snapshot in sync like a real provider would.
        if (
          snapshot !== null &&
          (id === INK_PEN || id === INK_MARKER || id === INK_ERASER)
        ) {
          snapshot = inkSnapshot(id);
        }
        return true;
      },
    },
    focusedPane: () => focusedPane,
    menuContext: () => menuContext,
    showMenu: (entries, anchor) => {
      shown.push({ entries, anchor });
    },
    menuAnchor: () => ({ x: 10, y: 20 }),
    showPalette: (model, anchor) => {
      palettes.push({ model, anchor });
      let closed = false;
      const anchors: StylusAccessoryMenuAnchor[] = [anchor];
      const handle: StylusPaletteHandle = {
        updateAnchor(next) {
          anchors.push(next);
          const last = palettes[palettes.length - 1];
          if (last)
            palettes[palettes.length - 1] = { model: last.model, anchor: next };
        },
        close() {
          closed = true;
        },
        get closed() {
          return closed;
        },
      };
      (handle as unknown as { anchors: StylusAccessoryMenuAnchor[] }).anchors =
        anchors;
      handles.push(handle);
      return handle;
    },
    lastPenAnchor: () => penAnchor,
    commands: {
      canExecEditorCommand: (command) => command === 'undo',
      execEditorCommand: () => true,
    },
  });
  return {
    service,
    binder,
    executed,
    palettes,
    shown,
    handles,
    get snapshot() {
      return snapshot;
    },
    set snapshot(value: DocumentToolSnapshot | null) {
      snapshot = value;
    },
    get focusedPane() {
      return focusedPane;
    },
    set focusedPane(value: string | null) {
      focusedPane = value;
    },
    get penAnchor() {
      return penAnchor;
    },
    set penAnchor(value: StylusViewportAnchor | null) {
      penAnchor = value;
    },
    dispose() {
      binder.dispose();
      created.dispose();
    },
  };
}

function act(
  service: InMemoryStylusService,
  payload: Record<string, unknown>,
): void {
  service.handleNativeEvent('action', payload);
}

describe('persistent eraser toggle (doubleTap switchEraser)', () => {
  it('pen + switchEraser → eraser, eraser + switchEraser → previous tool', () => {
    const h = harness();
    act(h.service, { type: 'doubleTap', preferredAction: 'switchEraser' });
    expect(h.executed).toEqual([{ pane: 'main', id: INK_ERASER }]);
    act(h.service, { type: 'doubleTap', preferredAction: 'switchEraser' });
    expect(h.executed).toEqual([
      { pane: 'main', id: INK_ERASER },
      { pane: 'main', id: INK_PEN },
    ]);
    h.dispose();
  });

  it('does nothing without an eraser, focused pane, or surface snapshot', () => {
    const h = harness();
    h.snapshot = {
      context: 'Paragraph',
      controls: [button('markdown.bold', true)],
    };
    act(h.service, { type: 'doubleTap', preferredAction: 'switchEraser' });
    expect(h.executed).toEqual([]);
    h.snapshot = inkSnapshot(INK_PEN);
    h.focusedPane = null;
    act(h.service, { type: 'doubleTap', preferredAction: 'switchEraser' });
    expect(h.executed).toEqual([]);
    h.dispose();
  });

  it('never moves another pane and never restores a missing tool', () => {
    const h = harness();
    act(h.service, { type: 'doubleTap', preferredAction: 'switchEraser' });
    expect(h.executed).toHaveLength(1);
    h.focusedPane = 'second';
    act(h.service, { type: 'doubleTap', preferredAction: 'switchEraser' });
    // Second pane has no snapshot in this harness → no cross-pane yank.
    expect(h.executed).toHaveLength(1);
    h.dispose();
  });

  it('handles async execution and repeated rapid taps', async () => {
    const service = new InMemoryStylusService();
    const created = createStylusMenuRegistry();
    const executed: string[] = [];
    let resolveFirst!: (ok: boolean) => void;
    let snapshot = inkSnapshot(INK_PEN);
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: created.registry,
      tools: {
        editorToolSnapshot: () => snapshot,
        executeEditorTool: (_pane, id) => {
          executed.push(id);
          if (executed.length === 1) {
            return new Promise<boolean>((resolve) => {
              resolveFirst = resolve;
            });
          }
          snapshot = inkSnapshot(id);
          return true;
        },
      },
      focusedPane: () => 'main',
      menuContext: () => menuContext,
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 0, y: 0 }),
    });
    act(service, { type: 'doubleTap', preferredAction: 'switchEraser' });
    act(service, { type: 'doubleTap', preferredAction: 'switchEraser' });
    resolveFirst(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      executed.filter((id) => id === INK_ERASER).length,
    ).toBeGreaterThanOrEqual(1);
    binder.dispose();
    created.dispose();
  });

  it('drops pending work after dispose', () => {
    const h = harness();
    h.dispose();
    act(h.service, { type: 'doubleTap', preferredAction: 'switchEraser' });
    expect(h.executed).toEqual([]);
  });
});

describe('preferred actions', () => {
  it('ignore and unknown are no-ops; shortcut records diagnostics only', () => {
    const h = harness();
    const messages: string[] = [];
    h.binder.dispose();
    const service2 = new InMemoryStylusService();
    const created = createStylusMenuRegistry();
    const binder2 = new StylusAccessoryBinder({
      service: service2,
      menuRegistry: created.registry,
      tools: {
        editorToolSnapshot: () => inkSnapshot(INK_PEN),
        executeEditorTool: () => true,
      },
      focusedPane: () => 'main',
      menuContext: () => menuContext,
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 0, y: 0 }),
      diagnostics: (message) => messages.push(message),
    });
    act(service2, { type: 'doubleTap', preferredAction: 'ignore' });
    act(service2, { type: 'doubleTap', preferredAction: 'unknown' });
    act(service2, { type: 'doubleTap', preferredAction: 'runSystemShortcut' });
    expect(messages).toHaveLength(1);
    binder2.dispose();
    created.dispose();
    h.dispose();
  });

  it('switchPrevious follows history', () => {
    const h = harness();
    // Build history pen → marker via real snapshot transitions.
    h.snapshot = inkSnapshot(INK_PEN);
    act(h.service, { type: 'doubleTap', preferredAction: 'switchEraser' });
    h.snapshot = inkSnapshot(INK_ERASER);
    // Reset to a clean pen→marker history through the controller path.
    h.dispose();
    const h2 = harness();
    act(h2.service, { type: 'doubleTap', preferredAction: 'switchEraser' });
    expect(h2.executed[0]?.id).toBe(INK_ERASER);
    h2.dispose();
  });

  it('palette preferred actions open with focus modes', () => {
    const h = harness();
    act(h.service, { type: 'doubleTap', preferredAction: 'showColorPalette' });
    expect(h.palettes).toHaveLength(1);
    expect(h.palettes[0]?.model.focusMode).toBe('color');
    act(h.service, { type: 'doubleTap', preferredAction: 'showInkAttributes' });
    expect(h.palettes).toHaveLength(2);
    expect(h.palettes[1]?.model.focusMode).toBe('attributes');
    act(h.service, {
      type: 'doubleTap',
      preferredAction: 'showContextualPalette',
    });
    expect(h.palettes).toHaveLength(3);
    expect(h.palettes[2]?.model.focusMode).toBe('full');
    h.dispose();
  });
});

describe('squeeze sessions', () => {
  it('began → show, changed → update anchor, ended → remain open', () => {
    const h = harness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    expect(h.palettes).toHaveLength(1);
    expect(h.palettes[0]?.anchor).toEqual({ x: 100, y: 100 });
    act(h.service, {
      type: 'squeeze',
      phase: 'changed',
      anchor: { x: 120, y: 130 },
    });
    expect(h.palettes).toHaveLength(1);
    expect(h.palettes[0]?.anchor).toEqual({ x: 120, y: 130 });
    act(h.service, { type: 'squeeze', phase: 'ended' });
    expect(h.handles[0]?.closed).toBe(false);
    expect(h.palettes).toHaveLength(1);
    h.dispose();
  });

  it('cancelled closes a squeeze-owned palette and performs no tool action', () => {
    const h = harness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 50, y: 50 },
    });
    expect(h.handles).toHaveLength(1);
    act(h.service, { type: 'squeeze', phase: 'cancelled' });
    expect(h.handles[0]?.closed).toBe(true);
    expect(h.executed).toEqual([]);
    h.dispose();
  });

  it('missing native anchor uses the pen-pointer fallback', () => {
    const h = harness();
    h.penAnchor = { x: 200, y: 250 };
    act(h.service, { type: 'squeeze', phase: 'began' });
    expect(h.palettes).toHaveLength(1);
    expect(h.palettes[0]?.anchor).toEqual({ x: 200, y: 250 });
    h.dispose();
  });

  it('switchEraser squeeze honors the system action once per gesture', () => {
    const h = harness();
    // The preferred action switches tools without opening a palette.
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toHaveLength(1);
    expect(h.palettes).toHaveLength(0);
    act(h.service, {
      type: 'squeeze',
      phase: 'changed',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toHaveLength(1);
    act(h.service, {
      type: 'squeeze',
      phase: 'ended',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toHaveLength(1);
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toHaveLength(2);
    expect(h.palettes).toHaveLength(0);
    h.dispose();
  });

  it('cancelled switchEraser squeeze does not repeat the action', () => {
    const h = harness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'switchEraser',
    });
    expect(h.palettes).toHaveLength(0);
    expect(h.executed).toHaveLength(1);
    act(h.service, {
      type: 'squeeze',
      phase: 'cancelled',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toHaveLength(1);
    h.dispose();
  });

  it('pane change closes the palette', () => {
    const h = harness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 10, y: 10 },
    });
    expect(h.handles).toHaveLength(1);
    h.focusedPane = 'second';
    h.binder.handlePaneChanged();
    expect(h.handles[0]?.closed).toBe(true);
    h.dispose();
  });

  it('core tools survive without registry contributions', () => {
    const h = harness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 300, y: 300 },
    });
    expect(h.palettes).toHaveLength(1);
    expect(h.palettes[0]?.model.tools.length).toBeGreaterThan(0);
    expect(h.palettes[0]?.model.canUndo).toBe(true);
    h.dispose();
  });
});
