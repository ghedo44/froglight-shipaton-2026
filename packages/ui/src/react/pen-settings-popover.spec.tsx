// @vitest-environment jsdom
/**
 * Goodnotes-inspired pen settings popover (§16).
 *
 * Hierarchy under test (structured provider schema):
 *
 * ```text
 * Title (active tool name)
 * Pen family selector (pen-type control: Ball/Fountain/Brush/Pencil)
 * Saved styles (visual cards)
 * Color (quick swatches + More)
 * Size (segmented widths + pt readout)
 * Core rows (highlighter opacity/straight; eraser/lasso equivalents)
 * Advanced disclosure (conditional brush props only)
 * ```
 *
 * Settings controls come from the real foundation builder
 * (`buildActiveToolSettingsControls`) so conditional emission and popover
 * grouping are covered end-to-end. Mounts `TopbarCenterTools` with a stub
 * provider port (legacy placement path: no shelf family siblings, so the
 * provider pen-type control is the selector; the shelf five-family row is
 * covered in `composition-shelf.spec.tsx`).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DocumentToolControl,
  DocumentToolSnapshot,
  SurfaceStylePreset,
} from '@froglight/foundation';
import {
  buildActiveToolSettingsControls,
  type SurfaceToolSettingsHost,
} from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { TopbarCenterTools } from './UnifiedToolbar.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Call = readonly [id: string, value?: string];

const WIDTHS = [2, 3.5, 6] as const;
const SWATCHES = [
  '#111111',
  '#ff0000',
  '#00ff00',
  '#0000ff',
  '#ffff00',
  '#ff00ff',
  '#00ffff',
  '#ffffff',
] as const;

const TOOL_LABELS: Record<string, string> = {
  pen: 'Ball Pen',
  fountain: 'Fountain Pen',
  brush: 'Brush Pen',
  pencil: 'Pencil',
  highlighter: 'Highlighter',
  eraser: 'Eraser',
  lasso: 'Lasso',
};

function style(
  id: string,
  name: string,
  favorite: boolean,
): SurfaceStylePreset {
  return {
    id,
    name,
    toolKind: 'pen',
    preset: { color: '#111111', size: 3.5 },
    favorite,
    order: 0,
  };
}

function makeHost(activeTool: string): SurfaceToolSettingsHost {
  return {
    activeToolId: () => `froglight.ink.${activeTool}`,
    setTool: () => undefined,
    toolPreset: () => ({ color: '#111111', size: 3.5 }),
    setToolPreset: () => undefined,
    savedStyles: (tool) =>
      tool === 'pen'
        ? [style('s1', 'Daily', true), style('s2', 'Fine', false)]
        : [],
    currentStyleId: (tool) => (tool === 'pen' ? 's1' : null),
    saveCurrentStyle: () => null,
    applySavedStyle: () => false,
    updateSavedStyle: () => false,
    renameSavedStyle: () => false,
    favoriteSavedStyle: () => false,
    reorderSavedStyles: () => false,
    deleteSavedStyle: () => false,
    resetSavedStyle: () => false,
    savedStyleModified: () => false,
    eraserPreset: () => ({ radius: 12, mode: 'stroke', filter: 'all' }),
    setEraserPreset: () => undefined,
    lassoPreset: () => ({ mode: 'freehand', filter: 'all' }),
    setLassoPreset: () => undefined,
    recentColors: () => [],
    gestures: () => ({}),
    setGestures: () => undefined,
  };
}

function toolButton(key: string): DocumentToolControl {
  return {
    kind: 'button',
    id: `ink.tool.${key}`,
    group: 'draw',
    label: TOOL_LABELS[key] ?? key,
    shortLabel: TOOL_LABELS[key] ?? key,
    role: 'surface-tool',
    toolId: `ink.tool.${key}`,
    active: true,
  };
}

// Eraser modes: no mode dropdown — selection happens through
// two fixed-mode tools sharing one eraser engine. The legacy single
// `surface.erase` role is dormant (providers no longer emit it).
const ERASER_TOOLS = [
  {
    key: 'eraser-stroke',
    label: 'Stroke Eraser',
    role: 'surface.erase.stroke',
  },
  {
    key: 'eraser-precision',
    label: 'Precision Eraser',
    role: 'surface.erase.precision',
  },
] as const;

function eraserToolButtons(activeKey = 'eraser-stroke'): DocumentToolControl[] {
  return ERASER_TOOLS.map((member) => ({
    kind: 'button',
    id: `ink.tool.${member.key}`,
    group: 'draw',
    label: member.label,
    shortLabel: member.label,
    role: 'surface-tool',
    toolId: `ink.tool.${member.key}`,
    semanticRole: member.role,
    active: member.key === activeKey,
  }));
}

function snapshotFor(activeTool: string): DocumentToolSnapshot {
  const settings = buildActiveToolSettingsControls(makeHost(activeTool), {
    prefix: 'ink',
    swatches: [...SWATCHES],
    widths: [...WIDTHS],
  });
  const tools =
    activeTool === 'eraser' ? eraserToolButtons() : [toolButton(activeTool)];
  return { context: 'Ink canvas', controls: [...tools, ...settings] };
}

function makeTools(current: DocumentToolSnapshot): {
  calls: Call[];
  port: WorkbenchEditorToolsPort;
} {
  const calls: Call[] = [];
  return {
    calls,
    port: {
      onDidChange: () => ({ dispose: () => undefined }),
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => current,
      executeEditorTool: (_pane: string, id: string, value?: string) => {
        calls.push([id, value] as Call);
        return true;
      },
    },
  };
}

describe('pen settings popover hierarchy', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  const contributions = createDocumentToolbarRegistry();
  const placements = createToolbarPlacementRegistry();
  placements.registry.register({
    id: 'test.primary',
    anchor: 'topbar-center',
    controlIds: [
      'ink.tool.pen',
      'ink.tool.fountain',
      'ink.tool.brush',
      'ink.tool.pencil',
      'ink.tool.highlighter',
      'ink.tool.eraser',
      'ink.tool.eraser-stroke',
      'ink.tool.eraser-precision',
      'ink.tool.lasso',
    ],
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  function mount(activeTool: string): Call[] {
    if (root !== null) {
      act(() => root!.unmount());
      root = null;
    }
    host?.remove();
    const made = makeTools(snapshotFor(activeTool));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <TopbarCenterTools
          tools={made.port}
          contributions={contributions.registry}
          placements={placements.registry}
          pane="pane-1"
          documentId="doc-1"
          kindId="froglight.ink"
        />,
      );
    });
    return made.calls;
  }

  function openPopover(activeTool: string): {
    calls: Call[];
    panel: HTMLElement;
  } {
    const calls = mount(activeTool);
    // The eraser opens from its active trio member (Stroke), never a
    // single legacy trigger — providers no longer emit `surface.erase`.
    const triggerLabel =
      activeTool === 'eraser' ? 'Stroke Eraser' : TOOL_LABELS[activeTool];
    const trigger = host!.querySelector(
      `[data-toolbar="topbar-center"] button[aria-label="${triggerLabel}"]`,
    );
    if (!(trigger instanceof HTMLButtonElement))
      throw new Error(`missing trigger: ${activeTool}`);
    act(() => trigger.click());
    const panel = host!.querySelector('[role="dialog"]');
    if (!(panel instanceof HTMLElement)) throw new Error('missing dialog');
    return { calls, panel };
  }

  it('shows only controls specific to the active pen', () => {
    const { panel } = openPopover('pen');
    expect(panel.getAttribute('aria-label')).toBe('Ball Pen settings');
    expect(
      panel.querySelector('input[aria-label="Pressure response"]'),
    ).not.toBeNull();
    expect(panel.querySelector('[aria-label="Pen family"]')).toBeNull();
    expect(panel.querySelector('[aria-label="Saved styles"]')).toBeNull();
    expect(panel.querySelector('section[aria-label="Color"]')).toBeNull();
    expect(panel.querySelector('section[aria-label="Size"]')).toBeNull();
    expect(panel.textContent).not.toContain('Advanced');
  });

  it('limits ball-pen Advanced to pressure/smoothing/end-taper', () => {
    const { panel } = openPopover('pen');
    for (const name of [
      'Pressure response',
      'Pressure minimum',
      'Pressure maximum',
      'Stabilization',
      'Streamline',
      'Taper end',
    ]) {
      expect(
        panel.querySelector(`input[aria-label="${name}"]`),
        name,
      ).not.toBeNull();
    }
    // No meaningless sliders: fixed round nib, no tilt/velocity semantics.
    expect(panel.querySelector('input[aria-label="Tilt effect"]')).toBeNull();
    expect(panel.querySelector('[aria-label="Tip"]')).toBeNull();
    expect(panel.querySelector('[aria-label="Cap style"]')).toBeNull();
    expect(
      panel.querySelector('button[aria-label="Velocity pressure"]'),
    ).toBeNull();
    expect(panel.querySelector('input[aria-label="Taper start"]')).toBeNull();
  });

  it('shows nib controls for fountain but no velocity/tilt', () => {
    const { panel } = openPopover('fountain');
    expect(panel.querySelector('[aria-label="Tip"]')).not.toBeNull();
    expect(panel.querySelector('[aria-label="Cap style"]')).not.toBeNull();
    expect(
      panel.querySelector('input[aria-label="Taper start"]'),
    ).not.toBeNull();
    expect(
      panel.querySelector('button[aria-label="Velocity pressure"]'),
    ).toBeNull();
    expect(panel.querySelector('input[aria-label="Tilt effect"]')).toBeNull();
  });

  it('shows velocity pressure for brush but no nib/tilt controls', () => {
    const { panel } = openPopover('brush');
    expect(
      panel.querySelector('button[aria-label="Velocity pressure"]'),
    ).not.toBeNull();
    expect(panel.querySelector('input[aria-label="Tilt effect"]')).toBeNull();
    expect(panel.querySelector('[aria-label="Tip"]')).toBeNull();
  });

  it('shows tilt shading for pencil but no velocity control', () => {
    const { panel } = openPopover('pencil');
    expect(
      panel.querySelector('input[aria-label="Tilt effect"]'),
    ).not.toBeNull();
    expect(panel.querySelector('[aria-label="Tip"]')).not.toBeNull();
    expect(
      panel.querySelector('button[aria-label="Velocity pressure"]'),
    ).toBeNull();
  });

  it('shows only highlighter opacity', () => {
    const { panel } = openPopover('highlighter');
    expect(panel.querySelector('input[aria-label="Opacity"]')).not.toBeNull();
    expect(
      panel.querySelector('button[aria-label="Straight-line hold"]'),
    ).toBeNull();
    expect(panel.querySelector('section[aria-label="Color"]')).toBeNull();
    expect(panel.querySelector('section[aria-label="Size"]')).toBeNull();
    expect(panel.querySelector('[aria-label="Saved styles"]')).toBeNull();
  });

  it('organizes eraser size, filter, and auto-return without a mode dropdown', () => {
    const { calls, panel } = openPopover('eraser');
    expect(panel.getAttribute('aria-label')).toBe('Stroke Eraser settings');
    // no mode dropdown — the provider emits no
    // `surface.settings.eraser-mode` role. Mode changes route via the
    // two fixed-mode eraser tools in the topbar.
    for (const name of ['Stroke Eraser', 'Precision Eraser']) {
      expect(
        host!.querySelector(
          `[data-toolbar="topbar-center"] button[aria-label="${name}"]`,
        ),
      ).not.toBeNull();
    }
    expect(panel.querySelector('[aria-label="Eraser mode"]')).toBeNull();
    expect(
      panel.querySelector('button[aria-label^="Eraser mode:"]'),
    ).toBeNull();
    expect(panel.querySelector('input[aria-label="Eraser size"]')).toBeNull();
    expect(
      panel.querySelector('select[aria-label="Erase content"]'),
    ).not.toBeNull();
    expect(
      panel.querySelector('button[aria-label="Return to previous tool"]'),
    ).not.toBeNull();
    // No family selector, saved styles, or Advanced for the eraser.
    expect(panel.querySelector('[aria-label="Pen family"]')).toBeNull();
    expect(panel.querySelector('[aria-label="Saved styles"]')).toBeNull();
    const precision = host!.querySelector(
      '[data-toolbar="topbar-center"] button[aria-label="Precision Eraser"]',
    );
    if (!(precision instanceof HTMLButtonElement))
      throw new Error('missing Precision Eraser tool');
    act(() => precision.click());
    expect(calls).toEqual([['ink.tool.eraser-precision', undefined]]);
  });

  it('organizes lasso freehand/rectangle and content filter', () => {
    const { calls, panel } = openPopover('lasso');
    expect(panel.getAttribute('aria-label')).toBe('Lasso settings');
    expect(
      panel.querySelector('button[aria-label="Lasso mode: Freehand"]'),
    ).not.toBeNull();
    const rect = panel.querySelector(
      'button[aria-label="Lasso mode: Rectangle"]',
    );
    if (!(rect instanceof HTMLButtonElement))
      throw new Error('missing Rectangle mode');
    act(() => rect.click());
    expect(calls).toEqual([['ink.settings.lasso.mode', 'rectangle']]);
    expect(
      panel.querySelector('select[aria-label="Select content"]'),
    ).not.toBeNull();
  });
});
