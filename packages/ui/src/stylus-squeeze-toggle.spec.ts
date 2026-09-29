/**
 * Absolute squeeze toggle state machine + outside dismissal (binder seam).
 *
 * Every physical squeeze toggles exactly once: a closed palette opens, and
 * the next squeeze closes it without close-and-reopen behavior. Phased
 * squeezes use `began` as the one toggle edge per gesture
 * (`idle ↔ tracking-open ↔ tracking-close ↔
 * palette-active`): `changed` only follows an open palette's anchor,
 * `ended` only settles (never toggles, never executes), `cancelled` only
 * cleans. Phaseless squeezes (`{type:squeeze}` with no `phase`) toggle
 * atomically via an explicit complete-squeeze path (never tracking-stuck).
 * System `preferredSqueezeAction` never replaces the toggle: every
 * preferred squeeze value toggles; palette values only select focus mode
 * on open; double-tap keeps separate semantics. Consequences:
 *
 * - closed + began/changed/ended opens exactly once, stays open.
 * - open + next began/changed/ended closes exactly once, never
 *   reopens on that gesture's tail.
 * - phaseless #1 opens, #2 closes, #3 opens, #4 closes;
 *   phased-open→phaseless-close and phaseless-open→phased-close interleave.
 * - Repeated phaseless squeezes never stick in tracking.
 * - Changed/ended tails never toggle again.
 * - Duplicate `began` in one gesture absorbed; duplicate/stale `ended`
 *   absorbed (never toggles, never executes).
 * - Lone `changed`/`ended`/`cancelled` with no gesture is tolerance, not
 *   an edge (never opens, never executes, never closes a settled palette).
 * - Outside dismissal (backdrop pointer DOWN, Escape) and pane/document
 *   change reconcile through `handlePaletteClosed`/`handlePaneChanged`;
 *   the next squeeze (phased began or phaseless) opens fresh.
 * - Rapid gestures alternate OPEN/CLOSE/OPEN/CLOSE deterministically.
 *
 * Keep liveness, equality, diagnostics, browsed-vs-active behavior,
 * coarse/compact behavior, double-tap semantics, and the
 * `refreshSqueezePalette`/`updateModel`/`updateAnchor` port shapes aligned.
 * Physical Pencil behavior is not verified in a lab.
 */

import { describe, expect, it } from 'vitest';
import {
  InMemoryStylusService,
  type DocumentToolSnapshot,
} from '@froglight/foundation';
import {
  StylusAccessoryBinder,
  type StylusAccessoryMenuAnchor,
  type StylusPaletteHandle,
} from './stylus-accessory.js';
import type { StylusPaletteModel } from './stylus-palette-model.js';
import { createStylusMenuRegistry } from './stylus-menu-registry.js';
import { createDocumentToolbarRegistry } from './document-toolbar-registry.js';
import { createToolbarCompositionRegistry } from './toolbar/composition-registry.js';
import { defaultToolbarComposition } from './toolbar/default-composition.js';

function surfaceButton(
  id: string,
  extra: Record<string, unknown> = {},
): DocumentToolSnapshot['controls'][number] {
  const toolRole = id.endsWith('.pen')
    ? 'pen'
    : id.endsWith('.highlighter')
      ? 'highlighter'
      : id.endsWith('.eraser')
        ? 'eraser'
        : undefined;
  const semanticRole = id.endsWith('.pen')
    ? 'surface.pen.ball'
    : id.endsWith('.highlighter')
      ? 'surface.highlighter'
      : id.endsWith('.eraser')
        ? 'surface.erase'
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
  } as DocumentToolSnapshot['controls'][number];
}

function surfaceSnapshot(): DocumentToolSnapshot {
  return {
    context: 'Ink canvas',
    controls: [
      surfaceButton('ink.tool.froglight.ink.pen', { active: true }),
      surfaceButton('ink.tool.froglight.ink.highlighter'),
      surfaceButton('ink.tool.froglight.ink.eraser'),
      {
        kind: 'color',
        id: 'ink.color',
        group: 'style',
        label: 'Stroke color',
        value: '#37352f',
        options: ['#37352f', '#7c6cf0'],
        semanticRole: 'surface.style.color',
      },
      {
        kind: 'choice',
        id: 'ink.width',
        group: 'style',
        label: 'Stroke width',
        value: '3.5',
        options: [{ value: '3.5', label: '3.5 px' }],
        semanticRole: 'surface.style.width',
      },
    ] as DocumentToolSnapshot['controls'],
  };
}

interface ToggleHandle extends StylusPaletteHandle {
  updated: StylusPaletteModel[];
}

function toggleHarness(
  opts: {
    showPaletteThrows?: boolean;
    anchorThrows?: boolean;
  } = {},
) {
  const service = new InMemoryStylusService();
  const menus = createStylusMenuRegistry();
  const composition = createToolbarCompositionRegistry();
  const toolbarControls = createDocumentToolbarRegistry();
  const defaults = defaultToolbarComposition();
  for (const entry of defaults.categories)
    composition.registry.registerCategory(entry);
  for (const entry of defaults.items) composition.registry.registerItem(entry);
  for (const entry of defaults.extensions)
    composition.registry.registerKindExtension(entry);
  let snapshot: DocumentToolSnapshot = surfaceSnapshot();
  let focusedPane: string | null = 'main';
  const palettes: Array<{
    model: StylusPaletteModel;
    anchor: StylusAccessoryMenuAnchor;
  }> = [];
  const handles: ToggleHandle[] = [];
  const executed: Array<{ pane: string; id: string }> = [];
  const diagnostics: string[] = [];
  let closeCount = 0;
  const binder = new StylusAccessoryBinder({
    service,
    menuRegistry: menus.registry,
    toolbarComposition: composition.registry,
    toolbarRegistry: toolbarControls.registry,
    tools: {
      editorToolSnapshot: () => snapshot,
      executeEditorTool: (pane, id) => {
        executed.push({ pane, id });
        // Realistic provider commit so post-execute refresh reconciles.
        try {
          if (
            snapshot.controls.some(
              (control) => control.kind === 'button' && control.id === id,
            )
          ) {
            snapshot = {
              ...snapshot,
              controls: snapshot.controls.map((control) =>
                control.kind === 'button' && control.role === 'surface-tool'
                  ? { ...control, active: control.id === id }
                  : control,
              ),
            } as DocumentToolSnapshot;
          }
        } catch {
          // Commit simulation never breaks execution recording.
        }
        return true;
      },
    },
    focusedPane: () => focusedPane,
    menuContext: () => ({
      pane: 'main',
      documentId: 'doc-1',
      kindId: 'froglight.ink',
    }),
    showMenu: () => undefined,
    menuAnchor: () => ({ x: 10, y: 20 }),
    showPalette: (model, anchor) => {
      if (opts.showPaletteThrows === true) throw new Error('presentation boom');
      palettes.push({ model, anchor });
      const updated: StylusPaletteModel[] = [];
      let closed = false;
      const handle = {
        updated,
        updateAnchor: () => {
          if (opts.anchorThrows === true) throw new Error('anchor boom');
        },
        updateModel(next: StylusPaletteModel): void {
          updated.push(next);
        },
        close() {
          closed = true;
          closeCount += 1;
        },
        get closed() {
          return closed;
        },
      } satisfies ToggleHandle;
      handles.push(handle as ToggleHandle);
      return handle;
    },
    commands: {
      canExecEditorCommand: () => false,
      execEditorCommand: () => false,
    },
    diagnostics: (message) => {
      diagnostics.push(message);
    },
  });
  return {
    service,
    binder,
    palettes,
    handles,
    executed,
    diagnostics,
    closeCount: () => closeCount,
    setPane(pane: string | null) {
      focusedPane = pane;
    },
    /** Simulate the overlay closing itself (outside DOWN / Escape). */
    overlaySelfClose(index = 0) {
      handles[index]?.close();
      binder.handlePaletteClosed();
    },
    dispose() {
      binder.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    },
  };
}

function act(
  service: InMemoryStylusService,
  payload: Record<string, unknown>,
): void {
  service.handleNativeEvent('action', payload);
}

function gesture(
  service: InMemoryStylusService,
  phases: Array<Record<string, unknown>>,
): void {
  for (const phase of phases) act(service, { type: 'squeeze', ...phase });
}

describe('H3-A closed squeeze opens exactly once and stays open', () => {
  it('began/changed/changed/ended opens once, remains open, tail phases never re-toggle', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', anchor: { x: 100, y: 100 } },
        { phase: 'changed', anchor: { x: 120, y: 130 } },
        { phase: 'changed', anchor: { x: 140, y: 150 } },
        { phase: 'ended' },
      ]);
      expect(h.palettes).toHaveLength(1);
      expect(h.handles[0]?.closed).toBe(false);
      expect(h.closeCount()).toBe(0);
      // Stale tail phases after settle are not new gestures: no re-toggle.
      act(h.service, { type: 'squeeze', phase: 'changed' });
      act(h.service, { type: 'squeeze', phase: 'ended' });
      expect(h.palettes).toHaveLength(1);
      expect(h.handles[0]?.closed).toBe(false);
      expect(h.closeCount()).toBe(0);
    } finally {
      h.dispose();
    }
  });
});

describe('H3-B open squeeze closes exactly once and never reopens on its tail', () => {
  it('next began/changed/ended closes once; ended must not reopen; following began opens fresh', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', anchor: { x: 100, y: 100 } },
        { phase: 'ended' },
      ]);
      expect(h.palettes).toHaveLength(1);
      // Second physical squeeze while open: began is the close edge.
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 200, y: 200 },
      });
      expect(h.handles[0]?.closed).toBe(true);
      expect(h.closeCount()).toBe(1);
      expect(h.palettes).toHaveLength(1);
      // Its changed/ended tail must not reopen (no close+reopen).
      act(h.service, {
        type: 'squeeze',
        phase: 'changed',
        anchor: { x: 210, y: 210 },
      });
      act(h.service, { type: 'squeeze', phase: 'ended' });
      expect(h.palettes).toHaveLength(1);
      expect(h.closeCount()).toBe(1);
      // A third squeeze opens fresh again.
      gesture(h.service, [
        { phase: 'began', anchor: { x: 50, y: 50 } },
        { phase: 'ended' },
      ]);
      expect(h.palettes).toHaveLength(2);
      expect(h.handles[1]?.closed).toBe(false);
    } finally {
      h.dispose();
    }
  });
});

describe('H3-C outside dismissal reconciles so the next began opens fresh', () => {
  it('overlay self-close drops the stale handle; mid-gesture dismissal never reopens', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', anchor: { x: 100, y: 100 } },
        { phase: 'ended' },
      ]);
      expect(h.palettes).toHaveLength(1);
      h.overlaySelfClose();
      // Next began opens fresh (never toggles the dead handle).
      gesture(h.service, [
        { phase: 'began', anchor: { x: 60, y: 60 } },
        { phase: 'ended' },
      ]);
      expect(h.palettes).toHaveLength(2);
      expect(h.handles[1]?.closed).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('outside dismissal mid-gesture (before ended) stays closed through ended', () => {
    const h = toggleHarness();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 100, y: 100 },
      });
      expect(h.palettes).toHaveLength(1);
      // User taps outside while the squeeze is still in flight.
      h.overlaySelfClose();
      act(h.service, { type: 'squeeze', phase: 'ended' });
      expect(h.palettes).toHaveLength(1);
      expect(h.closeCount()).toBe(1);
    } finally {
      h.dispose();
    }
  });
});

describe('System preferred squeeze actions', () => {
  it('switchEraser executes once per gesture without opening the palette', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', preferredAction: 'switchEraser' },
        { phase: 'ended', preferredAction: 'switchEraser' },
      ]);
      expect(h.palettes).toHaveLength(0);
      expect(h.executed).toHaveLength(1);
      gesture(h.service, [
        { phase: 'began', preferredAction: 'switchEraser' },
        { phase: 'changed', preferredAction: 'switchEraser' },
        { phase: 'ended', preferredAction: 'switchEraser' },
      ]);
      expect(h.palettes).toHaveLength(0);
      expect(h.executed).toHaveLength(2);
    } finally {
      h.dispose();
    }
  });

  it('switchPrevious routes through tool history without opening the palette', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', preferredAction: 'switchPrevious' },
        { phase: 'ended', preferredAction: 'switchPrevious' },
      ]);
      expect(h.palettes).toHaveLength(0);
      expect(h.executed).toEqual([]);
      gesture(h.service, [
        { phase: 'began', preferredAction: 'switchPrevious' },
        { phase: 'ended', preferredAction: 'switchPrevious' },
      ]);
      expect(h.palettes).toHaveLength(0);
      expect(h.executed).toEqual([]);
    } finally {
      h.dispose();
    }
  });

  it('ignore/unknown/runSystemShortcut do not open the palette', () => {
    for (const preferredAction of [
      'ignore',
      'unknown',
      'runSystemShortcut',
    ] as const) {
      const h = toggleHarness();
      try {
        gesture(h.service, [
          { phase: 'began', preferredAction },
          { phase: 'ended', preferredAction },
        ]);
        expect(h.palettes).toHaveLength(0);
        expect(h.executed).toEqual([]);
        gesture(h.service, [
          { phase: 'began', preferredAction },
          { phase: 'ended', preferredAction },
        ]);
        expect(h.palettes).toHaveLength(0);
        expect(h.executed).toEqual([]);
      } finally {
        h.dispose();
      }
    }
  });

  it('SECOND-ALWAYS-CLOSES: any second squeeze while open closes (mixed actions/anchors)', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', anchor: { x: 100, y: 100 } },
        { phase: 'ended' },
      ]);
      expect(h.handles[0]?.closed).toBe(false);
      // Second squeeze with a different action + anchor still closes.
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        preferredAction: 'showColorPalette',
        anchor: { x: 5, y: 5 },
      });
      expect(h.handles[0]?.closed).toBe(true);
      expect(h.closeCount()).toBe(1);
      expect(h.palettes).toHaveLength(1);
      act(h.service, { type: 'squeeze', phase: 'ended' });
      expect(h.palettes).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('FOCUS-ONLY: palette actions only select focus mode on open; close ignores focus', () => {
    const cases = [
      { preferredAction: 'showColorPalette', focusMode: 'color' },
      { preferredAction: 'showInkAttributes', focusMode: 'attributes' },
      { preferredAction: 'showContextualPalette', focusMode: 'full' },
    ] as const;
    for (const { preferredAction, focusMode } of cases) {
      const h = toggleHarness();
      try {
        gesture(h.service, [
          { phase: 'began', preferredAction, anchor: { x: 10, y: 10 } },
          { phase: 'ended' },
        ]);
        expect(h.palettes[0]?.model.focusMode).toBe(focusMode);
        expect(h.executed).toEqual([]);
        // OPEN + palette action closes regardless of its focus value.
        gesture(h.service, [
          { phase: 'began', preferredAction },
          { phase: 'ended' },
        ]);
        expect(h.handles[0]?.closed).toBe(true);
        expect(h.executed).toEqual([]);
      } finally {
        h.dispose();
      }
    }
  });

  it('DOUBLE-TAP-PRESERVED contrast: doubleTap switchEraser executes, squeeze switchEraser never does', () => {
    const h = toggleHarness();
    try {
      act(h.service, { type: 'doubleTap', preferredAction: 'switchEraser' });
      expect(h.executed).toEqual([
        { pane: 'main', id: 'ink.tool.froglight.ink.eraser' },
      ]);
      expect(h.palettes).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });
});

describe('H3-E/H3-F dismissal paths settle so began reopens', () => {
  it('Escape-equivalent self-close settles to idle; began reopens', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', anchor: { x: 100, y: 100 } },
        { phase: 'ended' },
      ]);
      h.overlaySelfClose();
      gesture(h.service, [
        { phase: 'began', anchor: { x: 70, y: 70 } },
        { phase: 'ended' },
      ]);
      expect(h.palettes).toHaveLength(2);
      expect(h.handles[1]?.closed).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('pane change closes; began afterwards opens fresh', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', anchor: { x: 10, y: 10 } },
        { phase: 'ended' },
      ]);
      expect(h.handles[0]?.closed).toBe(false);
      h.setPane('second');
      h.binder.handlePaneChanged();
      expect(h.handles[0]?.closed).toBe(true);
      h.setPane('main');
      gesture(h.service, [
        { phase: 'began', anchor: { x: 10, y: 10 } },
        { phase: 'ended' },
      ]);
      expect(h.palettes).toHaveLength(2);
      expect(h.handles[1]?.closed).toBe(false);
    } finally {
      h.dispose();
    }
  });
});

describe('H3-G cancelled first cleans so the next gesture behaves', () => {
  it('began/cancelled closes with no action; next full gesture opens once and stays open', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', anchor: { x: 50, y: 50 } },
        { phase: 'cancelled' },
      ]);
      expect(h.handles[0]?.closed).toBe(true);
      expect(h.executed).toEqual([]);
      gesture(h.service, [
        { phase: 'began', anchor: { x: 51, y: 51 } },
        { phase: 'changed', anchor: { x: 52, y: 52 } },
        { phase: 'ended' },
      ]);
      expect(h.palettes).toHaveLength(2);
      expect(h.handles[1]?.closed).toBe(false);
    } finally {
      h.dispose();
    }
  });
});

describe('H3-H rapid gestures alternate deterministically; duplicates absorbed', () => {
  it('OPEN/CLOSE/OPEN/CLOSE across four sequential gestures', () => {
    const h = toggleHarness();
    try {
      for (let i = 0; i < 4; i += 1) {
        gesture(h.service, [
          { phase: 'began', anchor: { x: 10 + i, y: 10 + i } },
          { phase: 'ended' },
        ]);
      }
      expect(h.palettes).toHaveLength(2);
      expect(h.closeCount()).toBe(2);
      expect(h.handles[1]?.closed).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('duplicate began frames inside one gesture never double-toggle', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', anchor: { x: 10, y: 10 } },
        { phase: 'began', anchor: { x: 11, y: 11 } },
        { phase: 'changed', anchor: { x: 12, y: 12 } },
        { phase: 'ended' },
      ]);
      expect(h.palettes).toHaveLength(1);
      expect(h.handles[0]?.closed).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('TAIL-NO-TOGGLE: duplicate/stale ended never toggles and never executes', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', anchor: { x: 10, y: 10 } },
        { phase: 'ended' },
        { phase: 'ended' },
      ]);
      expect(h.palettes).toHaveLength(1);
      expect(h.handles[0]?.closed).toBe(false);
      expect(h.executed).toEqual([]);
    } finally {
      h.dispose();
    }
    const d = toggleHarness();
    try {
      // The action executes on began; duplicate ended does not repeat it.
      gesture(d.service, [
        { phase: 'began', preferredAction: 'switchEraser' },
        { phase: 'ended', preferredAction: 'switchEraser' },
        { phase: 'ended', preferredAction: 'switchEraser' },
      ]);
      expect(d.palettes).toHaveLength(0);
      expect(d.executed).toHaveLength(1);
    } finally {
      d.dispose();
    }
  });

  it('lone ended/changed tolerance: never opens, never executes, never closes settled', () => {
    const h = toggleHarness();
    try {
      // Lone ended with no gesture is tolerance, never an edge.
      act(h.service, { type: 'squeeze', phase: 'ended' });
      expect(h.palettes).toHaveLength(0);
      expect(h.executed).toEqual([]);
      // Lone discrete ended is also tolerance now (no execution).
      act(h.service, {
        type: 'squeeze',
        phase: 'ended',
        preferredAction: 'switchEraser',
      });
      act(h.service, {
        type: 'squeeze',
        phase: 'ended',
        preferredAction: 'switchEraser',
      });
      expect(h.executed).toEqual([]);
      expect(h.palettes).toHaveLength(0);
      // Lone changed is tolerance too.
      act(h.service, {
        type: 'squeeze',
        phase: 'changed',
        anchor: { x: 1, y: 1 },
      });
      expect(h.palettes).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('stale ended after cancel never repeats the preferred action', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', preferredAction: 'switchEraser' },
        { phase: 'cancelled', preferredAction: 'switchEraser' },
        { phase: 'ended', preferredAction: 'switchEraser' },
      ]);
      expect(h.executed).toHaveLength(1);
      expect(h.palettes).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });
});

describe('Phaseless atomic toggle (PHASELESS-1/2, PHASELESS-STUCK)', () => {
  it('phaseless #1 opens, #2 closes, #3 opens, #4 closes without tracking-stuck', () => {
    const h = toggleHarness();
    try {
      act(h.service, { type: 'squeeze' });
      expect(h.palettes).toHaveLength(1);
      expect(h.handles[0]?.closed).toBe(false);
      act(h.service, { type: 'squeeze' });
      expect(h.handles[0]?.closed).toBe(true);
      expect(h.closeCount()).toBe(1);
      expect(h.palettes).toHaveLength(1);
      act(h.service, { type: 'squeeze' });
      expect(h.palettes).toHaveLength(2);
      expect(h.handles[1]?.closed).toBe(false);
      act(h.service, { type: 'squeeze' });
      expect(h.handles[1]?.closed).toBe(true);
      expect(h.closeCount()).toBe(2);
      // PHASELESS-STUCK: two more phaseless still alternate (never stuck).
      act(h.service, { type: 'squeeze' });
      expect(h.palettes).toHaveLength(3);
      act(h.service, { type: 'squeeze' });
      expect(h.handles[2]?.closed).toBe(true);
      expect(h.palettes).toHaveLength(3);
    } finally {
      h.dispose();
    }
  });

  it('phased-open then phaseless closes; phaseless-open then phased closes', () => {
    const h = toggleHarness();
    try {
      gesture(h.service, [
        { phase: 'began', anchor: { x: 100, y: 100 } },
        { phase: 'ended' },
      ]);
      expect(h.handles[0]?.closed).toBe(false);
      act(h.service, { type: 'squeeze' });
      expect(h.handles[0]?.closed).toBe(true);
      expect(h.closeCount()).toBe(1);
    } finally {
      h.dispose();
    }
    const g = toggleHarness();
    try {
      act(g.service, { type: 'squeeze', anchor: { x: 40, y: 40 } });
      expect(g.handles[0]?.closed).toBe(false);
      gesture(g.service, [
        { phase: 'began', anchor: { x: 50, y: 50 } },
        { phase: 'ended' },
      ]);
      expect(g.handles[0]?.closed).toBe(true);
      expect(g.closeCount()).toBe(1);
      expect(g.palettes).toHaveLength(1);
    } finally {
      g.dispose();
    }
  });

  it('phaseless carries anchor and routes a later tool action separately', () => {
    const h = toggleHarness();
    try {
      act(h.service, {
        type: 'squeeze',
        preferredAction: 'showColorPalette',
        anchor: { x: 77, y: 88 },
      });
      expect(h.palettes).toHaveLength(1);
      expect(h.palettes[0]?.model.focusMode).toBe('color');
      expect(h.palettes[0]?.anchor).toEqual({ x: 77, y: 88 });
      expect(h.executed).toEqual([]);
      act(h.service, {
        type: 'squeeze',
        preferredAction: 'switchEraser',
      });
      expect(h.handles[0]?.closed).toBe(false);
      expect(h.executed).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('phaseless interrupts phased tracking without stranding the tail', () => {
    const h = toggleHarness();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(h.handles[0]?.closed).toBe(false);
      // Phaseless while a phased open gesture is still tracking closes.
      act(h.service, { type: 'squeeze' });
      expect(h.handles[0]?.closed).toBe(true);
      // The stale phased tail settles without reopening.
      act(h.service, { type: 'squeeze', phase: 'ended' });
      expect(h.palettes).toHaveLength(1);
      expect(h.closeCount()).toBe(1);
    } finally {
      h.dispose();
    }
  });
});

describe('H6-OVL binder fail-soft for overlay presentation paths', () => {
  it('throwing showPalette never breaks dispatch, reports, and the next began retries', () => {
    const h = toggleHarness({ showPaletteThrows: true });
    try {
      let threw = false;
      try {
        act(h.service, {
          type: 'squeeze',
          phase: 'began',
          anchor: { x: 10, y: 10 },
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(h.diagnostics.join('\n')).toContain(
        'squeeze palette presentation failed',
      );
      expect(h.palettes).toHaveLength(0);
      // The failed gesture settles cleanly; dispatch stays alive.
      let endedThrew = false;
      try {
        act(h.service, { type: 'squeeze', phase: 'ended' });
      } catch {
        endedThrew = true;
      }
      expect(endedThrew).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('throwing updateAnchor on changed never breaks dispatch', () => {
    const h = toggleHarness({ anchorThrows: true });
    try {
      let threw = false;
      try {
        gesture(h.service, [
          { phase: 'began', anchor: { x: 10, y: 10 } },
          { phase: 'changed', anchor: { x: 99, y: 99 } },
          { phase: 'ended' },
        ]);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(h.palettes).toHaveLength(1);
      expect(h.handles[0]?.closed).toBe(false);
    } finally {
      h.dispose();
    }
  });
});
