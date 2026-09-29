import {
  NEUTRAL_PRESSURE,
  SURFACE_TOOL_IDS,
  resolveBrushFootprint,
  type Camera,
  type EraserMode,
  type InkBrushSpec,
  type LassoMode,
  type Point,
} from '@froglight/foundation';
import { INK_TOOL_IDS } from './shape-tools.js';

export type SurfaceCursorTool =
  | { readonly kind: 'brush'; readonly brush: InkBrushSpec }
  | {
      readonly kind: 'eraser';
      readonly radiusView: number;
      readonly mode: EraserMode;
    }
  | { readonly kind: 'select' }
  | { readonly kind: 'lasso'; readonly mode: LassoMode }
  | { readonly kind: 'text' }
  | { readonly kind: 'shape' }
  | { readonly kind: 'unknown' };

export type SurfaceCursorAction =
  | 'tool'
  | 'move-selection'
  | 'grab'
  | 'grabbing'
  | 'nwse-resize'
  | 'nesw-resize'
  | 'ns-resize'
  | 'ew-resize';

export type SurfaceCursorDescriptor =
  | { readonly kind: 'native'; readonly cursor: string }
  | {
      readonly kind: 'custom';
      readonly shape: 'circle' | 'ellipse' | 'lasso';
      readonly width: number;
      readonly height: number;
      readonly rotation: number;
      readonly dashed: boolean;
      readonly precisionLocator: boolean;
      readonly marker: 'none' | 'stroke-eraser';
    };

const NATIVE_ACTION_CURSOR: Record<
  Exclude<SurfaceCursorAction, 'tool'>,
  string
> = {
  'move-selection': 'move',
  grab: 'grab',
  grabbing: 'grabbing',
  'nwse-resize': 'nwse-resize',
  'nesw-resize': 'nesw-resize',
  'ns-resize': 'ns-resize',
  'ew-resize': 'ew-resize',
};

/** Explicit tool mapping: foreign tools never become ink by suffix inference. */
export function cursorToolKind(toolId: string): SurfaceCursorTool['kind'] {
  if (
    toolId === SURFACE_TOOL_IDS.pen ||
    toolId === SURFACE_TOOL_IDS.fountain ||
    toolId === SURFACE_TOOL_IDS.brush ||
    toolId === SURFACE_TOOL_IDS.pencil ||
    toolId === SURFACE_TOOL_IDS.highlighter
  )
    return 'brush';
  if (toolId === SURFACE_TOOL_IDS.eraser) return 'eraser';
  if (toolId === SURFACE_TOOL_IDS.select) return 'select';
  if (toolId === SURFACE_TOOL_IDS.lasso) return 'lasso';
  if (toolId === INK_TOOL_IDS.text) return 'text';
  if (
    toolId === INK_TOOL_IDS.rect ||
    toolId === INK_TOOL_IDS.ellipse ||
    toolId === INK_TOOL_IDS.line
  )
    return 'shape';
  return 'unknown';
}

export function resolveSurfaceCursor(input: {
  readonly tool: SurfaceCursorTool;
  readonly camera: Camera;
  readonly action?: SurfaceCursorAction;
}): SurfaceCursorDescriptor {
  const action = input.action ?? 'tool';
  if (action !== 'tool') {
    return { kind: 'native', cursor: NATIVE_ACTION_CURSOR[action] };
  }
  switch (input.tool.kind) {
    case 'brush': {
      const footprint = resolveBrushFootprint(input.tool.brush, {
        // Hover cannot know future pressure. The compiler's neutral input is
        // stable and is also its fallback for samples without pressure.
        pressure: NEUTRAL_PRESSURE,
      });
      const width = footprint.width * input.camera.zoom;
      const height = footprint.height * input.camera.zoom;
      return {
        kind: 'custom',
        shape: footprint.shape,
        width,
        height,
        rotation: footprint.rotation,
        dashed: false,
        precisionLocator: Math.max(width, height) < 6,
        marker: 'none',
      };
    }
    case 'eraser': {
      // Eraser radius is already a view-unit contract. The engine divides it
      // by camera zoom for surface-space erasure; the cursor must not zoom it
      // a second time.
      const diameter = input.tool.radiusView * 2;
      return {
        kind: 'custom',
        shape: 'circle',
        width: diameter,
        height: diameter,
        rotation: 0,
        dashed: input.tool.mode === 'stroke',
        precisionLocator: diameter < 6,
        marker: input.tool.mode === 'stroke' ? 'stroke-eraser' : 'none',
      };
    }
    case 'lasso':
      if (input.tool.mode === 'rectangle')
        return { kind: 'native', cursor: 'crosshair' };
      return {
        kind: 'custom',
        shape: 'lasso',
        width: 18,
        height: 18,
        rotation: 0,
        dashed: false,
        precisionLocator: false,
        marker: 'none',
      };
    case 'text':
      return { kind: 'native', cursor: 'text' };
    case 'shape':
      return { kind: 'native', cursor: 'crosshair' };
    case 'select':
    case 'unknown':
      return { kind: 'native', cursor: 'default' };
  }
}

export interface SurfaceCursorSample {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
  /** Canvas-local CSS coordinates when the input controller already read layout. */
  readonly view?: Point;
  readonly contact: boolean;
  readonly action?: SurfaceCursorAction;
}

export interface SurfaceCursorPresenter {
  update(sample: SurfaceCursorSample): void;
  refresh(): void;
  leave(pointerId?: number): void;
  reset(): void;
  destroy(): void;
}

let activePresenter: SurfaceCursorPresenter | null = null;

function isAppleMobileWebKit(): boolean {
  try {
    const platform = navigator.platform ?? '';
    const ua = navigator.userAgent ?? '';
    return (
      /iPad|iPhone|iPod/.test(platform) ||
      /iPad|iPhone|iPod/.test(ua) ||
      (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  } catch {
    return false;
  }
}

/** DOM-only presentation. Geometry and semantic resolution stay pure above. */
export function createSurfaceCursorPresenter(options: {
  readonly canvas: HTMLCanvasElement;
  readonly coordinateElement?: HTMLElement;
  readonly indicator: HTMLElement;
  readonly resolveTool: () => SurfaceCursorTool;
  readonly camera: () => Camera;
  readonly supportsCustomCursor?: () => boolean;
}): SurfaceCursorPresenter {
  const coordinateElement = options.coordinateElement ?? options.canvas;
  let last: SurfaceCursorSample | null = null;
  let destroyed = false;
  const supportsCustom = (): boolean =>
    options.supportsCustomCursor?.() ?? !isAppleMobileWebKit();

  const hide = (cursor = ''): void => {
    options.indicator.style.display = 'none';
    options.canvas.style.cursor = cursor;
    options.canvas.dataset.cursorOwner =
      cursor === 'none' ? 'custom' : 'native';
  };

  const render = (): void => {
    if (destroyed || last === null) return;
    if (last.pointerType === 'touch') return;
    const point: Point =
      last.view ??
      (() => {
        const rect = coordinateElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
          return { x: Number.NaN, y: Number.NaN };
        const scaleX = rect.width / Math.max(coordinateElement.clientWidth, 1);
        const scaleY =
          rect.height / Math.max(coordinateElement.clientHeight, 1);
        return {
          x: (last.clientX - rect.left) / scaleX,
          y: (last.clientY - rect.top) / scaleY,
        };
      })();
    const inside =
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= 0 &&
      point.x <= coordinateElement.clientWidth &&
      point.y >= 0 &&
      point.y <= coordinateElement.clientHeight;
    if (!inside) {
      hide();
      return;
    }
    const descriptor = resolveSurfaceCursor({
      tool: options.resolveTool(),
      camera: options.camera(),
      ...(last.action !== undefined ? { action: last.action } : {}),
    });
    // A brush outline obscures the first contact samples. Eraser and lasso
    // feedback remain visible because their live footprint is actionable.
    if (
      descriptor.kind === 'custom' &&
      last.contact &&
      options.resolveTool().kind === 'brush'
    ) {
      hide('crosshair');
      return;
    }
    if (descriptor.kind === 'native' || !supportsCustom()) {
      hide(descriptor.kind === 'native' ? descriptor.cursor : 'crosshair');
      return;
    }
    if (activePresenter !== null && activePresenter !== presenter) {
      activePresenter.reset();
    }
    activePresenter = presenter;
    options.canvas.style.cursor = 'none';
    options.canvas.dataset.cursorOwner = 'custom';
    options.indicator.dataset.cursorShape = descriptor.shape;
    options.indicator.dataset.dashed = String(descriptor.dashed);
    options.indicator.dataset.precision = String(descriptor.precisionLocator);
    options.indicator.dataset.marker = descriptor.marker;
    options.indicator.dataset.pointer = last.pointerType || 'mouse';
    options.indicator.style.left = `${point.x}px`;
    options.indicator.style.top = `${point.y}px`;
    options.indicator.style.width = `${descriptor.width}px`;
    options.indicator.style.height = `${descriptor.height}px`;
    options.indicator.style.transform = `translate(-50%, -50%) rotate(${descriptor.rotation}rad)`;
    options.indicator.style.display = 'block';
  };

  const presenter: SurfaceCursorPresenter = {
    update(sample) {
      if (destroyed || sample.pointerType === 'touch') return;
      last = sample;
      render();
    },
    refresh: render,
    leave(pointerId) {
      if (pointerId !== undefined && last?.pointerId !== pointerId) return;
      last = null;
      hide();
      if (activePresenter === presenter) activePresenter = null;
    },
    reset() {
      last = null;
      hide();
      if (activePresenter === presenter) activePresenter = null;
    },
    destroy() {
      if (destroyed) return;
      presenter.reset();
      destroyed = true;
    },
  };
  return presenter;
}
