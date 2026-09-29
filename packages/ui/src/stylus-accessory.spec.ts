/**
 * Stylus accessory binder behavior.
 *
 * Headless throughout: the real `InMemoryStylusService` dispatches native
 * payloads, a real menu registry assembles entries, and narrow doubles
 * stand in for the workbench tools port and menu presentation.
 */

import { describe, expect, it } from 'vitest';
import {
  InMemoryStylusService,
  type DocumentToolSnapshot,
} from '@froglight/foundation';
import type { MenuEntry } from './menu.js';
import {
  StylusAccessoryBinder,
  findActiveSurfaceToolId,
  findSurfaceEraserControlId,
  isSurfaceEraserControlId,
  isSurfaceToolControlId,
  type StylusAccessoryMenuAnchor,
} from './stylus-accessory.js';
import {
  createStylusMenuRegistry,
  type StylusMenuContext,
} from './stylus-menu-registry.js';

const INK_ERASER = 'ink.tool.froglight.ink.eraser';
const INK_PEN = 'ink.tool.froglight.ink.pen';
const WHITEBOARD_ERASER = 'whiteboard.tool.eraser';
const WHITEBOARD_PEN = 'whiteboard.tool.pen';

function button(
  id: string,
  extra: { active?: boolean } = {},
): Extract<DocumentToolSnapshot['controls'][number], { kind: 'button' }> {
  const toolRole =
    id === INK_ERASER || id === WHITEBOARD_ERASER
      ? 'eraser'
      : id === INK_PEN || id === WHITEBOARD_PEN
        ? 'pen'
        : undefined;
  const semanticRole =
    id === INK_ERASER || id === WHITEBOARD_ERASER
      ? 'surface.erase'
      : id === INK_PEN || id === WHITEBOARD_PEN
        ? 'surface.pen.ball'
        : undefined;
  return {
    kind: 'button',
    id,
    group: 'draw',
    label: id,
    role: 'surface-tool',
    ...(toolRole !== undefined ? { toolRole } : {}),
    ...(semanticRole !== undefined ? { semanticRole } : {}),
    ...extra,
  } as Extract<DocumentToolSnapshot['controls'][number], { kind: 'button' }>;
}

function inkSnapshot(activeId: string | null): DocumentToolSnapshot {
  return {
    context: 'Ink canvas',
    controls: [INK_PEN, INK_ERASER].map((id) =>
      button(id, activeId === id ? { active: true } : {}),
    ),
  };
}

const menuContext: StylusMenuContext = {
  pane: 'main',
  documentId: 'doc-1',
  kindId: 'froglight.ink',
};

interface Harness {
  readonly service: InMemoryStylusService;
  readonly binder: StylusAccessoryBinder;
  readonly executed: Array<{ pane: string; id: string }>;
  readonly shown: Array<{
    entries: readonly MenuEntry[];
    anchor: StylusAccessoryMenuAnchor;
  }>;
  toolsSnapshot: DocumentToolSnapshot | null;
  focusedPane: string | null;
  context: StylusMenuContext | null;
  dispose(): void;
}

function harness(options: { withEntry?: boolean } = {}): Harness {
  const service = new InMemoryStylusService();
  const created = createStylusMenuRegistry();
  if (options.withEntry === true) {
    created.registry.register({
      id: 'acme.palette',
      entries: () => [{ label: 'Acme recipe' }],
    });
  }
  const executed: Harness['executed'] = [];
  const shown: Harness['shown'] = [];
  const state = {
    toolsSnapshot: inkSnapshot(INK_PEN) as DocumentToolSnapshot | null,
    focusedPane: 'main' as string | null,
    context: menuContext as StylusMenuContext | null,
  };
  const binder = new StylusAccessoryBinder({
    service,
    menuRegistry: created.registry,
    tools: {
      editorToolSnapshot: () => state.toolsSnapshot,
      executeEditorTool: (pane, id) => {
        executed.push({ pane, id });
        return true;
      },
    },
    focusedPane: () => state.focusedPane,
    menuContext: () => state.context,
    showMenu: (entries, anchor) => {
      shown.push({ entries, anchor });
    },
    menuAnchor: () => ({ x: 10, y: 20 }),
  });
  return {
    service,
    binder,
    executed,
    shown,
    get toolsSnapshot() {
      return state.toolsSnapshot;
    },
    set toolsSnapshot(value: DocumentToolSnapshot | null) {
      state.toolsSnapshot = value;
    },
    get focusedPane() {
      return state.focusedPane;
    },
    set focusedPane(value: string | null) {
      state.focusedPane = value;
    },
    get context() {
      return state.context;
    },
    set context(value: StylusMenuContext | null) {
      state.context = value;
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

describe('control-id matchers', () => {
  it('recognizes surface tool controls across family dialects', () => {
    expect(isSurfaceToolControlId(INK_ERASER)).toBe(true);
    expect(isSurfaceToolControlId(WHITEBOARD_ERASER)).toBe(true);
    expect(isSurfaceToolControlId('notebook.tool.froglight.ink.eraser')).toBe(
      true,
    );
    expect(isSurfaceToolControlId('ink.frame-width')).toBe(false);
    expect(isSurfaceToolControlId('ink.export')).toBe(false);
  });

  it('matches eraser controls in full-id and short-key dialects', () => {
    expect(isSurfaceEraserControlId(INK_ERASER)).toBe(true);
    expect(isSurfaceEraserControlId('notebook.tool.froglight.ink.eraser')).toBe(
      true,
    );
    expect(isSurfaceEraserControlId(WHITEBOARD_ERASER)).toBe(true);
    expect(isSurfaceEraserControlId(INK_PEN)).toBe(false);
    expect(isSurfaceEraserControlId('ink.export')).toBe(false);
  });

  it('finds eraser and active tool ids in snapshots', () => {
    const snapshot = inkSnapshot(INK_PEN);
    expect(findSurfaceEraserControlId(snapshot)).toBe(INK_ERASER);
    expect(findActiveSurfaceToolId(snapshot)).toBe(INK_PEN);
    expect(findActiveSurfaceToolId({ context: 'x', controls: [] })).toBeNull();
    expect(
      findSurfaceEraserControlId({ context: 'x', controls: [] }),
    ).toBeNull();
  });
});

describe('squeeze menu', () => {
  it('opens the core palette with contributions on squeeze began and phaseless squeeze', () => {
    const h = harness({ withEntry: true });
    act(h.service, { type: 'squeeze', phase: 'began' });
    expect(h.shown).toHaveLength(1);
    expect(
      h.shown[0]?.entries.map((entry) => (entry as { label?: string }).label),
    ).toEqual([INK_PEN, INK_ERASER, 'Acme recipe']);
    expect(h.shown[0]?.anchor).toEqual({ x: 10, y: 20 });
    h.dispose();
  });

  it('opens the core palette even with an empty registry', () => {
    const empty = harness();
    act(empty.service, { type: 'squeeze', phase: 'began' });
    expect(empty.shown).toHaveLength(1);
    expect(
      empty.shown[0]?.entries.map((entry) => (entry as { label?: string }).label),
    ).toEqual([INK_PEN, INK_ERASER]);
    empty.dispose();
  });

  it('ignores lone changed/ended/cancelled without an open session', () => {
    const h = harness({ withEntry: true });
    act(h.service, { type: 'squeeze', phase: 'changed' });
    act(h.service, { type: 'squeeze', phase: 'ended' });
    act(h.service, { type: 'squeeze', phase: 'cancelled' });
    expect(h.shown).toEqual([]);
    h.dispose();
  });

  it('still opens core tools when registry context is missing', () => {
    const filled = harness({ withEntry: true });
    filled.context = null;
    act(filled.service, { type: 'squeeze', phase: 'began' });
    expect(filled.shown).toHaveLength(1);
    filled.dispose();
  });

  it('stays closed for non-surface editors with an empty registry', () => {
    const h = harness();
    h.toolsSnapshot = {
      context: 'Paragraph',
      controls: [
        { kind: 'button', id: 'markdown.bold', group: 'text', label: 'Bold' },
      ],
    };
    act(h.service, { type: 'squeeze', phase: 'began' });
    expect(h.shown).toEqual([]);
    h.dispose();
  });

  it('ignores unbound buttons and proximity', () => {
    const h = harness({ withEntry: true });
    act(h.service, { type: 'primaryButton', pressed: true });
    act(h.service, { type: 'secondaryButton', pressed: false });
    act(h.service, { type: 'proximity', active: true });
    expect(h.shown).toEqual([]);
    expect(h.executed).toEqual([]);
    h.dispose();
  });

  it('treats legacy doubleTap without a preferred action as a no-op', () => {
    const h = harness({ withEntry: true });
    act(h.service, { type: 'doubleTap' });
    expect(h.shown).toEqual([]);
    expect(h.executed).toEqual([]);
    h.dispose();
  });
});

describe('eraser auto-select with restore', () => {
  it('selects the eraser on press and restores the previous tool on release', () => {
    const h = harness();
    act(h.service, { type: 'eraser', active: true });
    expect(h.executed).toEqual([{ pane: 'main', id: INK_ERASER }]);
    // The provider reports the eraser as active now.
    h.toolsSnapshot = inkSnapshot(INK_ERASER);
    act(h.service, { type: 'eraser', active: false });
    expect(h.executed).toEqual([
      { pane: 'main', id: INK_ERASER },
      { pane: 'main', id: INK_PEN },
    ]);
    h.dispose();
  });

  it('matches short-key whiteboard control ids', () => {
    const h = harness();
    h.toolsSnapshot = {
      context: 'Whiteboard',
      controls: [WHITEBOARD_PEN, WHITEBOARD_ERASER].map((id) =>
        button(id, id === WHITEBOARD_PEN ? { active: true } : {}),
      ),
    };
    act(h.service, { type: 'eraser', active: true });
    expect(h.executed).toEqual([{ pane: 'main', id: WHITEBOARD_ERASER }]);
    h.dispose();
  });

  it('does nothing without an eraser control (non-surface editors)', () => {
    const h = harness();
    h.toolsSnapshot = {
      context: 'Paragraph',
      controls: [
        { kind: 'button', id: 'markdown.bold', group: 'text', label: 'Bold' },
      ],
    };
    act(h.service, { type: 'eraser', active: true });
    act(h.service, { type: 'eraser', active: false });
    expect(h.executed).toEqual([]);
    h.dispose();
  });

  it('does nothing without a focused pane or snapshot', () => {
    const h = harness();
    h.focusedPane = null;
    act(h.service, { type: 'eraser', active: true });
    expect(h.executed).toEqual([]);
    h.focusedPane = 'main';
    h.toolsSnapshot = null;
    act(h.service, { type: 'eraser', active: true });
    expect(h.executed).toEqual([]);
    h.dispose();
  });

  it('skips restore when already erasing, focus moved, or tools changed by hand', () => {
    const onEraser = harness();
    onEraser.toolsSnapshot = inkSnapshot(INK_ERASER);
    act(onEraser.service, { type: 'eraser', active: true });
    act(onEraser.service, { type: 'eraser', active: false });
    expect(onEraser.executed).toEqual([]);
    onEraser.dispose();

    const moved = harness();
    act(moved.service, { type: 'eraser', active: true });
    expect(moved.executed).toHaveLength(1);
    moved.focusedPane = 'second';
    act(moved.service, { type: 'eraser', active: false });
    expect(moved.executed).toHaveLength(1);
    moved.dispose();

    const manual = harness();
    act(manual.service, { type: 'eraser', active: true });
    // The user picked the pen by hand while the rubber was held.
    manual.toolsSnapshot = inkSnapshot(INK_PEN);
    act(manual.service, { type: 'eraser', active: false });
    expect(manual.executed).toEqual([{ pane: 'main', id: INK_ERASER }]);
    manual.dispose();
  });

  it('skips restore when the focused editor no longer has an eraser', () => {
    const h = harness();
    act(h.service, { type: 'eraser', active: true });
    expect(h.executed).toHaveLength(1);
    // The user switched to a non-surface document before release.
    h.toolsSnapshot = {
      context: 'Paragraph',
      controls: [
        { kind: 'button', id: 'markdown.bold', group: 'text', label: 'Bold' },
      ],
    };
    act(h.service, { type: 'eraser', active: false });
    expect(h.executed).toHaveLength(1);
    h.dispose();
  });

  it('stops reacting after dispose', () => {
    const h = harness({ withEntry: true });
    h.dispose();
    act(h.service, { type: 'squeeze', phase: 'began' });
    act(h.service, { type: 'eraser', active: true });
    expect(h.shown).toEqual([]);
    expect(h.executed).toEqual([]);
  });

  it('late async success after release repairs back to the previous tool', async () => {
    const service = new InMemoryStylusService();
    const created = createStylusMenuRegistry();
    const executed: Array<{ pane: string; id: string }> = [];
    let resolveEraser!: (ok: boolean) => void;
    let snapshot = inkSnapshot(INK_PEN);
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: created.registry,
      tools: {
        editorToolSnapshot: () => snapshot,
        executeEditorTool: (pane, id) => {
          executed.push({ pane, id });
          if (id === INK_ERASER) {
            return new Promise<boolean>((resolve) => {
              resolveEraser = resolve;
            });
          }
          return true;
        },
      },
      focusedPane: () => 'main',
      menuContext: () => null,
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 0, y: 0 }),
    });
    act(service, { type: 'eraser', active: true });
    expect(executed).toEqual([{ pane: 'main', id: INK_ERASER }]);
    // Rubber released before the switch completes.
    act(service, { type: 'eraser', active: false });
    expect(executed).toHaveLength(1);
    // Late success actually landed the editor on the eraser: repair.
    snapshot = inkSnapshot(INK_ERASER);
    resolveEraser(true);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executed).toEqual([
      { pane: 'main', id: INK_ERASER },
      { pane: 'main', id: INK_PEN },
    ]);
    binder.dispose();
    created.dispose();
  });

  it('late async failure after release creates no restore state', async () => {
    const service = new InMemoryStylusService();
    const created = createStylusMenuRegistry();
    const executed: Array<{ pane: string; id: string }> = [];
    let rejectEraser!: (reason?: unknown) => void;
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: created.registry,
      tools: {
        editorToolSnapshot: () => inkSnapshot(INK_PEN),
        executeEditorTool: (pane, id) => {
          executed.push({ pane, id });
          return new Promise<boolean>((_resolve, reject) => {
            rejectEraser = reject;
          });
        },
      },
      focusedPane: () => 'main',
      menuContext: () => null,
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 0, y: 0 }),
    });
    act(service, { type: 'eraser', active: true });
    act(service, { type: 'eraser', active: false });
    rejectEraser(new Error('nope'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executed).toEqual([{ pane: 'main', id: INK_ERASER }]);
    binder.dispose();
    created.dispose();
  });

  it('duplicate activate while pending does not double-restore', async () => {
    const service = new InMemoryStylusService();
    const created = createStylusMenuRegistry();
    const executed: Array<{ pane: string; id: string }> = [];
    const resolvers: Array<(ok: boolean) => void> = [];
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: created.registry,
      tools: {
        editorToolSnapshot: () => inkSnapshot(INK_PEN),
        executeEditorTool: (pane, id) => {
          executed.push({ pane, id });
          return new Promise<boolean>((resolve) => {
            resolvers.push(resolve);
          });
        },
      },
      focusedPane: () => 'main',
      menuContext: () => null,
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 0, y: 0 }),
    });
    act(service, { type: 'eraser', active: true });
    act(service, { type: 'eraser', active: true });
    expect(executed).toHaveLength(2);
    resolvers[0]!(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // First (superseded) success must not arm restore; second still pending.
    act(service, { type: 'eraser', active: false });
    expect(executed).toHaveLength(2);
    binder.dispose();
    created.dispose();
  });

  it('dispose while pending drops the late resolution', async () => {
    const service = new InMemoryStylusService();
    const created = createStylusMenuRegistry();
    const executed: Array<{ pane: string; id: string }> = [];
    let resolveEraser!: (ok: boolean) => void;
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: created.registry,
      tools: {
        editorToolSnapshot: () => inkSnapshot(INK_PEN),
        executeEditorTool: (pane, id) => {
          executed.push({ pane, id });
          return new Promise<boolean>((resolve) => {
            resolveEraser = resolve;
          });
        },
      },
      focusedPane: () => 'main',
      menuContext: () => null,
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 0, y: 0 }),
    });
    act(service, { type: 'eraser', active: true });
    binder.dispose();
    resolveEraser(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executed).toEqual([{ pane: 'main', id: INK_ERASER }]);
    created.dispose();
  });
});
