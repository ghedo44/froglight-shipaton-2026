/**
 * Fixture for the Chromium squeeze-palette dismissal test.
 *
 * Renders the REAL `StylusPaletteOverlay` (source + real CSS modules via
 * the vite dev server) with an instrumented model and exposes a small
 * `window.__squeeze` driver. A canvas stand-in behind the palette records
 * leaked pointer input (draw-through must stay empty); a probe button and
 * an editor input observe focus/click-through behavior.
 */
import {
  showStylusPalette,
  type StylusPaletteCallbacks,
} from '@froglight/ui/src/react/StylusPaletteOverlay.jsx';
import type { StylusPaletteModel } from '@froglight/ui/src/stylus-palette-model.js';

declare global {
  interface Window {
    __squeeze: {
      show(anchor?: { x: number; y: number }): void;
      close(): void;
      commitEraser(): void;
      strokes(): string[];
      log(): string[];
    };
  }
}

const events: string[] = [];
const strokes: string[] = [];

function record(message: string): void {
  events.push(message);
  const log = document.querySelector('#log');
  if (log !== null) log.textContent = events.join('\n');
}

function baseModel(): StylusPaletteModel {
  return {
    tools: [
      { id: 'ink.tool.pen', label: 'Pen', toolRole: 'pen', semanticRole: 'surface.pen.ball', active: true },
      { id: 'ink.tool.fountain', label: 'Fountain Pen', toolRole: 'pen', semanticRole: 'surface.pen.fountain', active: false },
      {
        id: 'ink.tool.highlighter',
        label: 'Highlighter',
        toolRole: 'highlighter',
        active: false,
      },
      { id: 'ink.tool.lasso', label: 'Lasso', toolRole: 'lasso', active: false },
      { id: 'ink.tool.eraser', label: 'Eraser', toolRole: 'eraser', active: false },
    ],
    activeToolId: 'ink.tool.pen',
    color: {
      id: 'ink.color',
      label: 'Stroke color',
      value: '#111111',
      options: ['#111111', '#7c6cf0', '#ca4036'],
    },
    width: {
      id: 'ink.width',
      label: 'Stroke width',
      value: '3.5',
      options: [{ value: '3.5', label: '3.5 px' }],
    },
    eraserSize: null,
    styles: null,
    canUndo: true,
    canRedo: false,
    focusMode: 'full',
    contributions: [
      {
        label: 'Acme recipe',
        run: () => {
          record('menu:Acme recipe');
        },
      },
    ],
  };
}

let current: StylusPaletteModel = baseModel();

const callbacks: StylusPaletteCallbacks = {
  onSelectTool: (id) => {
    record(`tool:${id}`);
  },
  onSelectColor: (id, value) => {
    record(`color:${id}=${value}`);
  },
  onSelectWidth: (id, value) => {
    record(`width:${id}=${value}`);
  },
  onSelectEraserSize: (id, value) => {
    record(`eraser-size:${id}=${value}`);
  },
  onSelectStyle: (id, value) => {
    record(`style:${id}=${value}`);
  },
  onUndo: () => {
    record('history:undo');
  },
  onRedo: () => {
    record('history:redo');
  },
  onSelectMenuEntry: (index) => {
    record(`menu-entry:${index}`);
  },
  onClose: () => {
    record('close');
  },
  onError: (message) => {
    record(`error:${message}`);
  },
};

let handle: ReturnType<typeof showStylusPalette> | null = null;

function show(anchor: { x: number; y: number } = { x: 500, y: 400 }): void {
  current = baseModel();
  handle = showStylusPalette(current, anchor, callbacks);
}

document.querySelector('#canvas')?.addEventListener('pointerdown', (event) => {
  strokes.push((event as PointerEvent).pointerType || 'mouse');
});

let probes = 0;
document.querySelector('#probe')?.addEventListener('click', () => {
  probes += 1;
  (document.querySelector('#probe') as HTMLButtonElement).textContent =
    `Probe ${probes}`;
});

document.querySelector('#show')?.addEventListener('click', () => {
  show();
});

document.querySelector('#commit-eraser')?.addEventListener('click', () => {
  current = {
    ...current,
    tools: current.tools.map((tool) => ({
      ...tool,
      active: tool.id === 'ink.tool.eraser',
    })),
    activeToolId: 'ink.tool.eraser',
  };
  handle?.updateModel?.(current);
});

window.__squeeze = {
  show,
  close: () => handle?.close(),
  commitEraser: () =>
    (document.querySelector('#commit-eraser') as HTMLButtonElement).click(),
  strokes: () => [...strokes],
  log: () => [...events],
};
