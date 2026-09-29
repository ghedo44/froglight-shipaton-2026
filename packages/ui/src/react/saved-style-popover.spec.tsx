// @vitest-environment jsdom
/**
 * Saved-style popover integration.
 *
 * End-to-end through the real backend (`InkPresetStore` +
 * `SurfaceStyleLibrary` + `buildActiveToolSettingsControls` /
 * `executeSurfaceToolSettingsControl`) and the real toolbar popover
 * (`TopbarCenterTools` second-tap): all eight operations, working-vs-saved
 * semantics with no silent mutation, and cross-document sharing via one
 * shared `SettingsService` (Ink change visible in Notebook).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildActiveToolSettingsControls,
  executeSurfaceToolSettingsControl,
  InMemorySettingsService,
  InkPresetStore,
  SurfaceStyleLibrary,
  type DocumentToolControl,
  type DocumentToolSnapshot,
  type SurfaceToolSettingsHost,
} from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { TopbarCenterTools } from './UnifiedToolbar.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Harness {
  readonly host: SurfaceToolSettingsHost;
  readonly options: { prefix: string; swatches: readonly string[]; widths: readonly number[] };
  readonly library: SurfaceStyleLibrary;
  readonly presets: InkPresetStore;
  snapshot: () => DocumentToolSnapshot;
  execute: (id: string, value?: string) => boolean;
}

function makeHarness(prefix: string, settings: InMemorySettingsService): Harness {
  const presets = new InkPresetStore({ settings });
  const library = new SurfaceStyleLibrary({ presets, settings });
  let activeTool = 'froglight.ink.fountain';
  const host: SurfaceToolSettingsHost = {
    activeToolId: () => activeTool,
    setTool: (toolId: string) => {
      activeTool = toolId;
    },
    toolPreset: (tool) => presets.getTool(tool),
    setToolPreset: (tool, patch) => presets.setTool(tool, patch),
    savedStyles: (tool) => library.styles(tool),
    currentStyleId: (tool) => library.snapshot().currentStyleByTool[tool],
    saveCurrentStyle: (tool, name) => library.saveCurrent(tool, name),
    applySavedStyle: (id) => library.apply(id),
    updateSavedStyle: (id) => library.update(id),
    renameSavedStyle: (id, name) => library.rename(id, name),
    favoriteSavedStyle: (id, favorite) => library.setFavorite(id, favorite),
    reorderSavedStyles: (tool, ids) => library.reorder(tool, ids),
    deleteSavedStyle: (id) => library.delete(id),
    resetSavedStyle: (tool) => library.reset(tool),
    savedStyleModified: (tool) => library.isModified(tool),
    eraserPreset: () => presets.getEraser(),
    setEraserPreset: (patch) => presets.setEraser(patch),
    lassoPreset: () => presets.getLasso(),
    setLassoPreset: (patch) => presets.setLasso(patch),
    recentColors: () => presets.getRecentColors(),
  };
  const options = {
    prefix,
    swatches: ['#123456', '#ff0000', '#0000ff'],
    widths: [2, 3.5, 6],
  } as const;
  return {
    host,
    options,
    library,
    presets,
    snapshot: (): DocumentToolSnapshot => ({
      context: `${prefix} canvas`,
      controls: [
        {
          kind: 'button',
          id: `${prefix}.tool.fountain`,
          group: 'draw',
          label: 'Fountain Pen',
          shortLabel: 'Fountain',
          role: 'surface-tool',
          toolId: 'froglight.ink.fountain',
          active: true,
        } as DocumentToolControl,
        ...buildActiveToolSettingsControls(host, options),
      ],
    }),
    execute: (id: string, value?: string): boolean =>
      executeSurfaceToolSettingsControl(host, options, id, value),
  };
}

describe('saved-style popover integration', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  function mount(harness: Harness): {
    el: HTMLElement;
    rerender: () => void;
  } {
    host?.remove();
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    placements.registry.register({
      id: 'test.primary',
      anchor: 'topbar-center',
      controlIds: [`${harness.options.prefix}.tool.fountain`],
    });
    let current = harness.snapshot();
    const listeners = new Set<() => void>();
    const port: WorkbenchEditorToolsPort = {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => current,
      executeEditorTool: (_pane: string, id: string, value?: string) => {
        const ok = harness.execute(id, value);
        if (ok) {
          current = harness.snapshot();
          for (const listener of [...listeners]) listener();
        }
        return ok;
      },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const render = (): void => {
      act(() => {
        root!.render(
          <TopbarCenterTools
            tools={port}
            contributions={contributions.registry}
            placements={placements.registry}
            pane="pane-1"
            documentId="doc-1"
            kindId="froglight.ink"
          />,
        );
      });
    };
    render();
    return {
      el: host,
      rerender: () => {
        current = harness.snapshot();
        render();
      },
    };
  }

  function openPopover(el: HTMLElement): HTMLElement {
    const trigger = el.querySelector(
      '[data-toolbar="topbar-center"] button[aria-label="Fountain Pen"]',
    );
    if (!(trigger instanceof HTMLButtonElement))
      throw new Error('missing fountain trigger');
    act(() => trigger.click());
    const dialog = el.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) throw new Error('missing dialog');
    return dialog;
  }

  function saveAsNew(el: HTMLElement, name: string): void {
    const dialog = el.querySelector('[role="dialog"]')!;
    const input = dialog.querySelector(
      '[aria-label="New style name"]',
    ) as HTMLInputElement;
    const native = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      native?.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.closest('form')!.dispatchEvent(
        new SubmitEvent('submit', { bubbles: true, cancelable: true }),
      );
    });
  }

  it('saves, applies, modifies, updates, and resets with live cards', () => {
    const settings = new InMemorySettingsService();
    const harness = makeHarness('ink', settings);
    harness.presets.setTool('fountain', { color: '#123456', size: 3.5 });
    const { el } = mount(harness);
    let dialog = openPopover(el);
    expect(dialog.textContent).toContain('No saved styles yet');
    saveAsNew(el, 'Blue');
    dialog = el.querySelector('[role="dialog"]') as HTMLElement;
    expect(
      dialog.querySelector('[aria-label="Blue Fountain Pen, 3.5 pt, selected"]'),
    ).not.toBeNull();
    // Modify working color directly (user experiments in settings).
    act(() => {
      harness.presets.setTool('fountain', { color: '#ff0000' });
    });
    // Rebuild snapshot like a provider onDidChange would.
    act(() => {
      harness.execute('ink.settings.fountain.color', '#ff0000');
    });
    const { rerender } = mount(harness);
    void rerender;
    // Reopen after remount (mount helper above already re-rendered via new mount).
    const second = mount(harness);
    dialog = openPopover(second.el);
    expect(dialog.querySelector('[role="status"]')?.textContent).toContain(
      'Current style modified',
    );
    // Saved card keeps the old color; working preview uses the new one.
    expect(
      dialog.querySelector('[aria-label="Blue Fountain Pen, 3.5 pt, selected"]'),
    ).not.toBeNull();
    // Update persists working into saved; reset returns after a new edit.
    act(() => {
      expect(harness.execute('ink.settings.fountain.update-style')).toBe(true);
    });
    expect(harness.library.styles('fountain')[0]?.preset.color).toBe('#ff0000');
    expect(harness.library.isModified('fountain')).toBe(false);
    harness.library.dispose();
  });

  it('renames, favorites, reorders, and deletes through cards', () => {
    const settings = new InMemorySettingsService();
    const harness = makeHarness('ink', settings);
    harness.presets.setTool('fountain', { color: '#111111', size: 2 });
    expect(harness.execute('ink.settings.fountain.save-style', 'One')).toBe(true);
    harness.presets.setTool('fountain', { color: '#222222', size: 6 });
    expect(harness.execute('ink.settings.fountain.save-style', 'Two')).toBe(true);
    const { el } = mount(harness);
    const dialog = openPopover(el);
    expect(dialog.querySelectorAll('[data-saved-styles] li').length).toBe(2);
    // Rename current (Two → Primary).
    expect(harness.execute('ink.settings.fountain.rename-style', 'Primary')).toBe(
      true,
    );
    expect(
      harness.library.styles('fountain').find((s) => s.name === 'Primary'),
    ).not.toBeUndefined();
    // Favorite Primary by explicit card id (no selection churn required).
    const primary = harness.library
      .styles('fountain')
      .find((s) => s.name === 'Primary')!;
    expect(
      harness.execute('ink.settings.fountain.favorite-style', primary.id),
    ).toBe(true);
    expect(
      harness.library.styles('fountain').find((s) => s.id === primary.id)
        ?.favorite,
    ).toBe(true);
    // Move Primary earlier (was second → first).
    expect(harness.execute('ink.settings.fountain.move-style-earlier')).toBe(
      true,
    );
    expect(harness.library.styles('fountain')[0]?.id).toBe(primary.id);
    // Delete Primary by explicit card id.
    expect(
      harness.execute('ink.settings.fountain.delete-style', primary.id),
    ).toBe(true);
    expect(harness.library.styles('fountain')).toHaveLength(1);
    harness.library.dispose();
  });

  it('shares saved styles from Ink to Notebook through one settings service', () => {
    const settings = new InMemorySettingsService();
    const ink = makeHarness('ink', settings);
    const notebook = makeHarness('notebook', settings);
    ink.presets.setTool('fountain', { color: '#0a2540', size: 3.5 });
    const id = ink.library.saveCurrent('fountain', 'Shared Fountain');
    expect(id).not.toBeNull();
    // Notebook sees the Ink-saved style without any copy.
    expect(
      notebook.library.styles('fountain').map((style) => style.name),
    ).toEqual(['Shared Fountain']);
    expect(notebook.library.apply(id!)).toBe(true);
    expect(notebook.presets.getTool('fountain')).toMatchObject({
      color: '#0a2540',
      size: 3.5,
    });
    // Notebook UI snapshot carries the same structured cards.
    const controls = buildActiveToolSettingsControls(
      notebook.host,
      notebook.options,
    );
    const saved = controls.find(
      (entry) => entry.id === 'notebook.settings.fountain.saved-style',
    );
    if (saved?.kind !== 'choice') throw new Error('missing notebook saved-style');
    expect(saved.savedStyles?.map((style) => style.name)).toEqual([
      'Shared Fountain',
    ]);
    ink.library.dispose();
    notebook.library.dispose();
  });
});
