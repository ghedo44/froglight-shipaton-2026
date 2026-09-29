// @vitest-environment jsdom
/**
 * Settled exclusive-tool tracking for toolbar reconciliation.
 *
 *
 * Pins the shared engine behavior behind `InkSurfaceHandle` (serving Ink,
 * Whiteboard, and Notebook pages through `mountInkSurface`):
 * - mount settles the default pen; manual `setTool` moves settled + live;
 * - `enterTemporaryTool` moves live only — snapshot `active` derived from
 *   the settled tool keeps reporting the pre-hold tool, so sticky
 *   per-group memory ignores temp by construction;
 * - `exitTemporaryTool` restores live without touching settled;
 * - an explicit `setTool` during temp wins and clears the temp entry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  SURFACE_TOOL_IDS,
  type SurfaceToolbarDrawTool,
} from '@froglight/foundation';
import {
  buildActiveToolSettingsControls,
  buildSurfaceDrawControls,
  buildSurfaceStyleControls,
  executeSurfaceToolSettingsControl,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { mountInkSurface, type InkSkeleton } from '../index.js';

function makeHost(): InkSkeleton {
  const root = document.createElement('div');
  const page = document.createElement('div');
  const canvas = document.createElement('canvas');
  const badge = document.createElement('div');
  const pointerIndicator = document.createElement('div');
  const overlayRoot = document.createElement('div');
  page.append(canvas, badge, pointerIndicator, overlayRoot);
  root.append(page);
  document.body.append(root);
  return { root, page, canvas, badge, pointerIndicator, overlayRoot };
}

const TOOLS: readonly SurfaceToolbarDrawTool[] = [
  SURFACE_TOOL_IDS.pen,
  SURFACE_TOOL_IDS.fountain,
  SURFACE_TOOL_IDS.eraser,
].map((toolId) => ({ key: toolId, toolId, label: toolId, icon: 'pen' }));

function activeByTool(
  host: Parameters<typeof buildSurfaceDrawControls>[0],
): Map<string, boolean> {
  return new Map(
    buildSurfaceDrawControls(host, { prefix: 'ink', tools: TOOLS }).map(
      (control) => [
        (control as unknown as { toolId: string }).toolId,
        (control as unknown as { active?: boolean }).active === true,
      ],
    ),
  );
}

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  document.body.replaceChildren();
});

function mount() {
  const restoreCanvas = installCanvasStub();
  cleanup.push(restoreCanvas);
  const handle = mountInkSurface({
    model: emptySurface(boundedFrame(800, 600)),
    host: makeHost(),
    markDirty: () => undefined,
  });
  cleanup.push(() => handle.destroy());
  return handle;
}

describe('settled exclusive tool (shared mount)', () => {
  it('mounts settled on the default pen', () => {
    const handle = mount();
    expect(handle.activeToolId()).toBe(SURFACE_TOOL_IDS.pen);
    expect(handle.settledActiveToolId()).toBe(SURFACE_TOOL_IDS.pen);
    const active = activeByTool(handle);
    expect(active.get(SURFACE_TOOL_IDS.pen)).toBe(true);
    expect(active.get(SURFACE_TOOL_IDS.eraser)).toBe(false);
  });

  it('moves settled and live together on manual selection', () => {
    const handle = mount();
    handle.setTool(SURFACE_TOOL_IDS.fountain);
    expect(handle.activeToolId()).toBe(SURFACE_TOOL_IDS.fountain);
    expect(handle.settledActiveToolId()).toBe(SURFACE_TOOL_IDS.fountain);
    const active = activeByTool(handle);
    expect(active.get(SURFACE_TOOL_IDS.fountain)).toBe(true);
    expect(active.get(SURFACE_TOOL_IDS.pen)).toBe(false);
    expect(active.get(SURFACE_TOOL_IDS.eraser)).toBe(false);
  });

  it('holds the settled tool while a temporary eraser is entered', () => {
    const handle = mount();
    handle.setTool(SURFACE_TOOL_IDS.fountain);
    handle.enterTemporaryTool(SURFACE_TOOL_IDS.eraser);
    // Live flips to the held tool; settled stays on the explicit choice.
    expect(handle.activeToolId()).toBe(SURFACE_TOOL_IDS.eraser);
    expect(handle.settledActiveToolId()).toBe(SURFACE_TOOL_IDS.fountain);
    // Toolbar derivation ignores temp: Write keeps its active marker, so
    // sticky memory never captures the hold and manual erase
    // below stays an honest exclusive flip.
    const active = activeByTool(handle);
    expect(active.get(SURFACE_TOOL_IDS.fountain)).toBe(true);
    expect(active.get(SURFACE_TOOL_IDS.eraser)).toBe(false);
  });

  it('sources contextual style values from the settled preset during temp', () => {
    const handle = mount();
    handle.setTool(SURFACE_TOOL_IDS.fountain);
    handle.setToolPreset('fountain', {
      color: '#7c6cf0',
      size: 6,
    });
    handle.enterTemporaryTool(SURFACE_TOOL_IDS.eraser);
    const controls = buildSurfaceStyleControls(handle, {
      prefix: 'ink',
      swatches: ['#7c6cf0'],
      widths: [2, 6],
    });
    // Fountain preset (settled), never eraser state or pen defaults.
    expect(controls[0]).toMatchObject({ value: '#7c6cf0' });
    expect(controls[1]).toMatchObject({ value: '6' });
  });

  it('keeps the slot-editor schema on the settled tool while temp is held', () => {
    const handle = mount();
    handle.setTool(SURFACE_TOOL_IDS.fountain);
    handle.enterTemporaryTool(SURFACE_TOOL_IDS.eraser);
    // Schema follows settled: fountain controls, not the
    // held eraser's — matching settled draw active + style values.
    const schemaIds = buildActiveToolSettingsControls(handle, {
      prefix: 'ink',
      swatches: ['#7c6cf0'],
      widths: [2, 6],
    }).map((control) => control.id);
    expect(schemaIds).toContain('ink.settings.fountain.type');
    for (const id of schemaIds) expect(id).toContain('.fountain.');
    // Slot edits route to the settled preset through the existing
    // settings commands.
    expect(
      executeSurfaceToolSettingsControl(
        handle,
        { prefix: 'ink', swatches: ['#7c6cf0'], widths: [2, 6] },
        'ink.settings.fountain.size',
        '6',
      ),
    ).toBe(true);
    expect(handle.toolPreset('fountain').size).toBe(6);
  });

  it('restores live on temp exit without moving settled', () => {
    const handle = mount();
    handle.setTool(SURFACE_TOOL_IDS.fountain);
    handle.enterTemporaryTool(SURFACE_TOOL_IDS.eraser);
    expect(handle.exitTemporaryTool()).toBe(true);
    expect(handle.activeToolId()).toBe(SURFACE_TOOL_IDS.fountain);
    expect(handle.settledActiveToolId()).toBe(SURFACE_TOOL_IDS.fountain);
    expect(handle.exitTemporaryTool()).toBe(false);
  });

  it('lets an explicit selection during temp win and clear the entry', () => {
    const handle = mount();
    handle.setTool(SURFACE_TOOL_IDS.fountain);
    handle.enterTemporaryTool(SURFACE_TOOL_IDS.eraser);
    handle.setTool(SURFACE_TOOL_IDS.pen);
    expect(handle.activeToolId()).toBe(SURFACE_TOOL_IDS.pen);
    expect(handle.settledActiveToolId()).toBe(SURFACE_TOOL_IDS.pen);
    // The temp entry is gone: nothing left to restore (no-hijack —
    // the explicit Write choice stands on its own).
    expect(handle.exitTemporaryTool()).toBe(false);
  });
});
