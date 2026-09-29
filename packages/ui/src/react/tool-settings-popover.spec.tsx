// @vitest-environment jsdom
/**
 * Second-tap tool settings popover (slice 8 UI layer).
 *
 * Tapping the already-active surface tool opens its settings popover
 * (unplaced `settings`-group snapshot controls) instead of re-executing;
 * every property acts through the existing command channel with live
 * snapshot values. Mounts `TopbarCenterTools` directly with a stub
 * provider port and one test placement.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentToolControl } from '@froglight/foundation';
import type { DocumentToolSnapshot } from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { TopbarCenterTools } from './UnifiedToolbar.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Call = readonly [id: string, value?: string];

function toolButton(
  id: string,
  label: string,
  active: boolean,
): DocumentToolControl {
  return {
    kind: 'button',
    id,
    group: 'draw',
    label,
    shortLabel: label,
    role: 'surface-tool',
    toolId: id,
    active,
  };
}

const SETTINGS: readonly DocumentToolControl[] = [
  {
    kind: 'choice',
    id: 'ink.settings.pen.size',
    group: 'settings',
    label: 'Size',
    value: '3.5',
    options: [
      { value: '2', label: 'Thin' },
      { value: '3.5', label: 'Medium' },
      { value: '6', label: 'Thick' },
    ],
  },
  {
    kind: 'button',
    id: 'ink.settings.pen.straight',
    group: 'settings',
    label: 'Straight-line hold',
    shortLabel: 'Straight',
  },
];

function snapshot(
  activeId: string,
  settings: readonly DocumentToolControl[] = SETTINGS,
): DocumentToolSnapshot {
  const active = (id: string): boolean => id === activeId;
  return {
    context: 'Ink canvas',
    controls: [
      toolButton('ink.tool.pen', 'Pen', active('ink.tool.pen')),
      toolButton(
        'ink.tool.highlighter',
        'Highlighter',
        active('ink.tool.highlighter'),
      ),
      toolButton('ink.tool.select', 'Select', active('ink.tool.select')),
      // The provider only emits settings for the active tool; select
      // carries no schema.
      ...(activeId === 'ink.tool.select' ? [] : settings),
    ],
  };
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

describe('second-tap tool settings popover', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  const contributions = createDocumentToolbarRegistry();
  const placements = createToolbarPlacementRegistry();
  placements.registry.register({
    id: 'test.primary',
    anchor: 'topbar-center',
    controlIds: ['ink.tool.pen', 'ink.tool.highlighter', 'ink.tool.select'],
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  function mount(current: DocumentToolSnapshot): Call[] {
    if (root !== null) {
      act(() => root!.unmount());
      root = null;
    }
    host?.remove();
    const made = makeTools(current);
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

  function trigger(label: string): HTMLButtonElement {
    const button = host!.querySelector(
      `[data-toolbar="topbar-center"] button[aria-label="${label}"]`,
    );
    if (!(button instanceof HTMLButtonElement))
      throw new Error(`missing trigger: ${label}`);
    return button;
  }

  function dialog(): HTMLElement | null {
    // No Pane layer in this harness, so the portal fallback renders inline.
    return host?.querySelector('[role="dialog"]') ?? null;
  }

  it('executes on first tap without opening settings', () => {
    const calls = mount(snapshot('ink.tool.select'));
    act(() => trigger('Pen').click());
    expect(calls).toEqual([['ink.tool.pen', undefined]]);
    expect(dialog()).toBeNull();
  });

  it('opens the settings dialog on second tap without executing', () => {
    const calls = mount(snapshot('ink.tool.pen'));
    act(() => trigger('Pen').click());
    expect(calls).toEqual([]);
    const panel = dialog();
    expect(panel?.getAttribute('aria-label')).toBe('Pen settings');
    expect(panel?.textContent).toContain('Size');
    expect(panel?.textContent).toContain('Straight-line hold');
  });

  it('routes settings actions through the command channel', () => {
    const calls = mount(snapshot('ink.tool.pen'));
    act(() => trigger('Pen').click());
    const panel = dialog();
    const size = panel?.querySelector('select[aria-label="Size"]');
    if (!(size instanceof HTMLSelectElement)) throw new Error('missing size');
    act(() => {
      size.value = '6';
      size.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(calls).toEqual([['ink.settings.pen.size', '6']]);
    // The dialog stays open across value commits (live snapshot values).
    expect(dialog()).not.toBeNull();
  });

  it('toggles the straight-line flag without a value', () => {
    const calls = mount(snapshot('ink.tool.pen'));
    act(() => trigger('Pen').click());
    const toggle = dialog()?.querySelector(
      'button[aria-label="Straight-line hold"]',
    );
    if (!(toggle instanceof HTMLButtonElement))
      throw new Error('missing toggle');
    act(() => toggle.click());
    expect(calls).toEqual([['ink.settings.pen.straight', undefined]]);
  });

  it('closes when the active tool changes', () => {
    mount(snapshot('ink.tool.pen'));
    act(() => trigger('Pen').click());
    expect(dialog()).not.toBeNull();
    // Highlighter activates elsewhere: pen deactivates, popover closes.
    mount(snapshot('ink.tool.highlighter'));
    expect(dialog()).toBeNull();
  });

  it('toggles closed on a third tap and closes on Escape', () => {
    mount(snapshot('ink.tool.pen'));
    const pen = trigger('Pen');
    act(() => pen.click());
    expect(dialog()).not.toBeNull();
    act(() => trigger('Pen').click());
    expect(dialog()).toBeNull();
    act(() => trigger('Pen').click());
    expect(dialog()).not.toBeNull();
    act(() => {
      trigger('Pen').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(dialog()).toBeNull();
  });

  it('closes on outside pointer down', () => {
    mount(snapshot('ink.tool.pen'));
    act(() => trigger('Pen').click());
    expect(dialog()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(dialog()).toBeNull();
  });

  it('executes normally for active tools without a settings schema', () => {
    const calls = mount(snapshot('ink.tool.select'));
    act(() => trigger('Select').click());
    // Select is active but carries no settings controls: plain execute.
    expect(calls).toEqual([['ink.tool.select', undefined]]);
    expect(dialog()).toBeNull();
  });
});
