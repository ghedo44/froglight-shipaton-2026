/**
 * Deterministic mock Document Tools for the Surface editor families
 * (spec #52). Gives every alternate Surface provider (ink, notebook,
 * whiteboard) a small in-memory implementation of the provider-neutral
 * tools seam — draw selection, stroke style, eraser radius, image
 * enablement, zoom cluster, and fit — so tests prove the seam works without
 * Canvas, DOM, or the production engine.
 *
 * Control ids reuse the production family prefixes (`ink.`, `notebook.`,
 * `whiteboard.`) and each family's production draw keys, so a provider swap
 * stays transparent to toolbar consumers for the covered subset.
 */

import type { DocumentEditorTools } from '../editors/tools.js';
import { SURFACE_TOOL_IDS } from '../surfaces/tools.js';
import { SURFACE_TOOLBAR_ZOOM_STEP } from '../editors/surface-toolbar-builder.js';

export interface MockSurfaceToolsOptions {
  /** Semantic context such as `Ink canvas` or `Whiteboard`. */
  readonly context: string;
  /** Control-id prefix such as `ink`, `notebook`, or `whiteboard`. */
  readonly prefix: string;
  /**
   * Draw tools offered by the mock. `key` is the control-id suffix and
   * `toolId` the engine tool id. Defaults to the five core Surface tools
   * with full surface ids as keys (the Ink/Notebook production dialect);
   * Whiteboard passes its short production keys so a provider swap stays
   * transparent.
   */
  readonly drawTools?: readonly MockSurfaceDrawTool[];
  /**
   * Whether image insertion reports as available. Mocks bind no asset
   * store, so this stays false unless a test explicitly opts in.
   */
  readonly canInsertImage?: boolean;
}

/** One mock draw entry: control-id suffix plus engine tool id. */
export interface MockSurfaceDrawTool {
  readonly key: string;
  readonly toolId: string;
  readonly label: string;
}

const CORE_DRAW_TOOLS: readonly MockSurfaceDrawTool[] = [
  {
    key: SURFACE_TOOL_IDS.select,
    toolId: SURFACE_TOOL_IDS.select,
    label: 'Select',
  },
  { key: SURFACE_TOOL_IDS.pen, toolId: SURFACE_TOOL_IDS.pen, label: 'Pen' },
  {
    key: SURFACE_TOOL_IDS.highlighter,
    toolId: SURFACE_TOOL_IDS.highlighter,
    label: 'Highlighter',
  },
  {
    key: SURFACE_TOOL_IDS.eraser,
    toolId: SURFACE_TOOL_IDS.eraser,
    label: 'Eraser',
  },
  {
    key: SURFACE_TOOL_IDS.lasso,
    toolId: SURFACE_TOOL_IDS.lasso,
    label: 'Lasso',
  },
];

/**
 * Full production draw dialects mirrored for the alternate providers (see
 * each family's editor provider for the authoritative tables). Centralized
 * here so the three mock handles cannot drift from each other.
 */
export const MOCK_INK_DRAW_TOOLS: readonly MockSurfaceDrawTool[] = [
  ...CORE_DRAW_TOOLS,
  {
    key: 'froglight.ink.rect',
    toolId: 'froglight.ink.rect',
    label: 'Rectangle',
  },
  {
    key: 'froglight.ink.ellipse',
    toolId: 'froglight.ink.ellipse',
    label: 'Ellipse',
  },
  { key: 'froglight.ink.line', toolId: 'froglight.ink.line', label: 'Line' },
  { key: 'froglight.ink.text', toolId: 'froglight.ink.text', label: 'Text' },
];

export const MOCK_NOTEBOOK_DRAW_TOOLS: readonly MockSurfaceDrawTool[] = [
  ...CORE_DRAW_TOOLS,
  {
    key: 'froglight.ink.rect',
    toolId: 'froglight.ink.rect',
    label: 'Rectangle',
  },
  {
    key: 'froglight.ink.ellipse',
    toolId: 'froglight.ink.ellipse',
    label: 'Ellipse',
  },
  { key: 'froglight.ink.line', toolId: 'froglight.ink.line', label: 'Line' },
  {
    key: 'froglight.notebook.text',
    toolId: 'froglight.notebook.text',
    label: 'Text',
  },
];

export const MOCK_WHITEBOARD_DRAW_TOOLS: readonly MockSurfaceDrawTool[] = [
  { key: 'pen', toolId: SURFACE_TOOL_IDS.pen, label: 'Pen' },
  {
    key: 'highlighter',
    toolId: SURFACE_TOOL_IDS.highlighter,
    label: 'Highlighter',
  },
  { key: 'select', toolId: SURFACE_TOOL_IDS.select, label: 'Select' },
  {
    key: 'eraser-stroke',
    toolId: SURFACE_TOOL_IDS.eraser,
    label: 'Stroke eraser',
  },
  { key: 'lasso', toolId: SURFACE_TOOL_IDS.lasso, label: 'Lasso' },
  { key: 'text', toolId: 'froglight.ink.text', label: 'Text' },
  { key: 'card', toolId: 'froglight.whiteboard.card', label: 'Card' },
  { key: 'rect', toolId: 'froglight.ink.rect', label: 'Rectangle' },
  { key: 'ellipse', toolId: 'froglight.ink.ellipse', label: 'Ellipse' },
  { key: 'line', toolId: 'froglight.ink.line', label: 'Line' },
];

/**
 * Creates an isolated in-memory tools implementation. Each call owns its
 * state; listeners fire once per successful command and dispose cleanly.
 */
export function createMockSurfaceTools(
  options: MockSurfaceToolsOptions,
): DocumentEditorTools {
  const { context, prefix } = options;
  const drawTools = options.drawTools ?? CORE_DRAW_TOOLS;
  const imageAvailable = options.canInsertImage ?? false;
  let activeToolId: string = SURFACE_TOOL_IDS.select;
  let penColor = '#37352f';
  let penWidth = 3;
  let eraserRadius = 10;
  let zoom = 100;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    snapshot: () => ({
      context,
      controls: [
        ...drawTools.map((tool) => ({
          kind: 'button' as const,
          id: `${prefix}.tool.${tool.key}`,
          group: 'draw',
          label: tool.label,
          shortLabel: tool.label,
          active: activeToolId === tool.toolId,
        })),
        {
          kind: 'color' as const,
          id: `${prefix}.color`,
          group: 'style',
          label: 'Stroke color',
          value: penColor,
          options: ['#37352f', '#7c6cf0', '#c4554d', '#448361', '#a08430'],
        },
        {
          kind: 'choice' as const,
          id: `${prefix}.width`,
          group: 'style',
          label: 'Stroke width',
          value: String(penWidth),
          options: [2, 3.5, 6].map((width) => ({
            value: String(width),
            label: `${width} px`,
          })),
        },
        {
          kind: 'range' as const,
          id: `${prefix}.eraser-radius`,
          group: 'style',
          label: 'Eraser size',
          value: eraserRadius,
          min: 2,
          max: 40,
          step: 1,
        },
        {
          kind: 'button' as const,
          id: `${prefix}.image`,
          group: 'insert',
          label: 'Insert image',
          shortLabel: 'Image',
          disabled: !imageAvailable,
        },
        {
          kind: 'button' as const,
          id: `${prefix}.zoom-out`,
          group: 'view',
          label: 'Zoom out',
          shortLabel: '−',
        },
        {
          kind: 'button' as const,
          id: `${prefix}.zoom-reset`,
          group: 'view',
          label: `Zoom ${zoom}%, activate to reset to 100%`,
          shortLabel: `${zoom}%`,
        },
        {
          kind: 'number' as const,
          id: `${prefix}.zoom`,
          group: 'view',
          label: 'Zoom',
          value: zoom,
          min: 25,
          max: 800,
          step: 1,
          suffix: '%',
        },
        {
          kind: 'range' as const,
          id: `${prefix}.zoom-slider`,
          group: 'view',
          label: 'Zoom slider',
          value: zoom,
          min: 25,
          max: 800,
          step: 5,
        },
        {
          kind: 'button' as const,
          id: `${prefix}.zoom-in`,
          group: 'view',
          label: 'Zoom in',
          shortLabel: '+',
        },
        {
          kind: 'button' as const,
          id: `${prefix}.fit`,
          group: 'view',
          label: 'Fit',
          shortLabel: 'Fit',
        },
      ],
    }),
    execute: (id, value) => {
      const toolPrefix = `${prefix}.tool.`;
      if (id.startsWith(toolPrefix)) {
        const tool = drawTools.find(
          (entry) => entry.key === id.slice(toolPrefix.length),
        );
        if (tool !== undefined) {
          activeToolId = tool.toolId;
          notify();
          return true;
        }
        return false;
      }
      if (id === `${prefix}.color` && value !== undefined) {
        penColor = value;
        notify();
        return true;
      }
      if (id === `${prefix}.width` && value !== undefined) {
        penWidth = Number(value);
        notify();
        return true;
      }
      if (id === `${prefix}.eraser-radius` && value !== undefined) {
        eraserRadius = Number(value);
        notify();
        return true;
      }
      if (id === `${prefix}.image`) {
        notify();
        return true;
      }
      if (
        (id === `${prefix}.zoom` || id === `${prefix}.zoom-slider`) &&
        value !== undefined
      ) {
        zoom = Math.round(Number(value));
        notify();
        return true;
      }
      if (id === `${prefix}.zoom-in`) {
        zoom = Math.round(zoom * SURFACE_TOOLBAR_ZOOM_STEP);
        notify();
        return true;
      }
      if (id === `${prefix}.zoom-out`) {
        zoom = Math.round(zoom / SURFACE_TOOLBAR_ZOOM_STEP);
        notify();
        return true;
      }
      if (id === `${prefix}.zoom-reset`) {
        zoom = 100;
        notify();
        return true;
      }
      if (id === `${prefix}.fit`) {
        // No camera in the mock: the command is accepted and observed,
        // with no zoom state to reconcile.
        notify();
        return true;
      }
      return false;
    },
    onDidChange: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  };
}
