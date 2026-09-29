/**
 * Ink document editor provider: binds the shared
 * ink surface engine (`surface.ts`) to a DocumentSession behind the
 * generic editor registry seam, with a headless fallback for environments
 * without Canvas 2D.
 *
 * Creation tools (shapes, lines/arrows, text) are provider-level registry
 * citizens committing core surface objects — they demonstrate exactly the
 * extension seam an external trusted plugin would use. The bounded page
 * frame resizes by dragging its borders (Paint-style); PNG export renders
 * derived pixels only and can never replace canonical vectors.
 */

import { createDerivedCachePackWorker } from './surface/derived-cache-packer.js';
import {
  buildActiveToolSettingsControls,
  buildSurfaceDrawControls,
  buildSurfaceArrangeControls,
  buildSurfaceExportControl,
  buildSurfaceFitControl,
  buildSurfaceImageControl,
  buildSurfaceStyleControls,
  buildSurfaceTextControls,
  buildSurfaceZoomControls,
  createDefaultSurfaceObjectTypeRegistry,
  createSharedSurfaceDrawTools,
  createSharedSurfaceEraserTools,
  DerivedReopenStore,
  executeSurfaceTextControl,
  executeSurfaceToolbarControl,
  executeSurfaceToolSettingsControl,
  frameBounds,
  renderSurfaceScene,
  SURFACE_TOOL_IDS,
  surfaceTextControlIds,
  templateBackgroundDrawItems,
  type CompositionImage,
  type DerivedCacheStoragePort,
  type DocumentAssetStore,
  type SurfaceModel,
  type SurfaceTextExecuteHost,
  type SurfaceToolbarDrawTool,
} from '@froglight/foundation';
import {
  CanvasSurfaceRendererBackend,
  type SurfaceImageResolver,
} from '@froglight/surface-default';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createSurfaceImageCache, type DecodedImage } from './images.js';
import { InkSurfaceSkeleton } from './react/InkSurfaceSkeleton.jsx';
import {
  executeSurfacePaperControl,
  surfacePaper,
  surfacePaperControls,
} from './paper.js';
import {
  hasCanvas2d,
  INK_TOOL_IDS,
  MAX_ERASER_RADIUS,
  MAX_FRAME_SIZE,
  MAX_ZOOM,
  MIN_ERASER_RADIUS,
  MIN_FRAME_SIZE,
  MIN_ZOOM,
  mountInkSurface,
  resolveMountReopen,
  SWATCHES,
  WIDTH_DOTS,
  type InkSkeleton,
  type InkSurfaceHandle,
  type MountReopen,
} from './surface.js';
import type {
  StylusInputPolicy,
  DocumentEditorHandle,
  DocumentEditorTools,
  DocumentEditorProvider,
} from '@froglight/foundation';
import type { SettingsService } from '@froglight/foundation';
import { documentKindId } from '@froglight/foundation';

const INK_PAGE_KIND_ID = 'froglight.ink';

/**
 * Declared Ink toolbar profile for the shared surface builder: the twelve
 * canonical Surface draw tools with the Ink engine-id dialect (full surface
 * tool ids as control-id keys) with the single eraser replaced by two modes
 *
 * Labels, icons, groups, coarse roles, semantic roles, and ordering come
 * from the shared family tables (`createSharedSurfaceDrawTools` +
 * `createSharedSurfaceEraserTools`) so Ink cannot diverge from Notebook or
 * Whiteboard; only the bounded frame and PNG export stay Ink-local. The
 * `surface.erase.tool` composition id itself is never renamed — it stays
 * dormant for persisted overrides/old hosts while providers emit the two
 * fixed-mode tools (`surface.erase.stroke/precision`) over the
 * single eraser engine.
 */
const INK_DRAW_BASE: readonly SurfaceToolbarDrawTool[] =
  createSharedSurfaceDrawTools({
    pen: SURFACE_TOOL_IDS.pen,
    fountain: SURFACE_TOOL_IDS.fountain,
    brush: SURFACE_TOOL_IDS.brush,
    pencil: SURFACE_TOOL_IDS.pencil,
    highlighter: SURFACE_TOOL_IDS.highlighter,
    eraser: SURFACE_TOOL_IDS.eraser,
    select: SURFACE_TOOL_IDS.select,
    lasso: SURFACE_TOOL_IDS.lasso,
    line: INK_TOOL_IDS.line,
    rectangle: INK_TOOL_IDS.rect,
    triangle: INK_TOOL_IDS.triangle,
    diamond: INK_TOOL_IDS.diamond,
    ellipse: INK_TOOL_IDS.ellipse,
    text: INK_TOOL_IDS.text,
  });

const INK_DRAW_TOOLS: readonly SurfaceToolbarDrawTool[] = [
  ...INK_DRAW_BASE.slice(0, 5),
  ...createSharedSurfaceEraserTools(SURFACE_TOOL_IDS.eraser),
  ...INK_DRAW_BASE.slice(6),
];

/**
 * Grouped surface-text execute.
 *
 * Thin `ink` dialect over the shared `executeSurfaceTextControl`
 * (foundation owns the additive `setSelectionStyle` mapping; the shared
 * engine owns selection mutation and the pending style for newly placed text.
 */
export function executeInkTextControl(
  host: SurfaceTextExecuteHost,
  id: string,
  value: unknown,
): boolean {
  return executeSurfaceTextControl(host, 'ink', id, value);
}
/**
 * Browser-capable adapter for composition previews. The returned PNG is a
 * disposable derived projection; canonical `.ink` bytes remain vector data.
 * When an asset store is supplied, `froglight.image` objects are decoded
 * first so previews render real bitmaps instead of placeholders.
 */
export async function renderInkPreviewImage(
  model: SurfaceModel,
  options: {
    assets?: DocumentAssetStore | null;
    decodeImage?: (bytes: Uint8Array) => Promise<DecodedImage | null>;
  } = {},
): Promise<CompositionImage | undefined> {
  if (typeof document === 'undefined') return undefined;
  let images: SurfaceImageResolver | undefined;
  if (options.assets != null) {
    const cache = createSurfaceImageCache({
      assets: options.assets,
      ...(options.decodeImage !== undefined
        ? { decode: options.decodeImage }
        : {}),
    });
    await cache.requestSurface(model);
    images = cache.resolver;
  }
  const frame = frameBounds(model.frame) ?? { width: 800, height: 600 };
  const scale = Math.max(
    Math.min(1.5, 1200 / frame.width, 900 / frame.height),
    0.05,
  );
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) return undefined;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  renderSurfaceScene(
    new CanvasSurfaceRendererBackend(context, { images }),
    model,
    createDefaultSurfaceObjectTypeRegistry(),
    { x: 0, y: 0, zoom: scale },
    { width, height, dpr: 1 },
    {
      backgroundItems: templateBackgroundDrawItems(
        surfacePaper(model).template,
        frame.width,
        frame.height,
        surfacePaper(model),
      ),
    },
  );
  try {
    return {
      mimeType: 'image/png',
      dataUrl: canvas.toDataURL('image/png'),
      alt: 'Ink page preview',
      width,
      height,
    };
  } catch {
    return undefined;
  }
}
interface SurfaceSessionBridge {
  readonly model: SurfaceModel;
  readonly openMetadata?: Readonly<Record<string, unknown>>;
  readonly document?: { readonly documentId?: unknown };
  /** Live session revision (property read at each cache use). */
  readonly contentRevision?: string | null;
  /** Live session dirty flag (property read at each cache use). */
  readonly dirty?: boolean;
  markDirty(): void;
}

class InkPageCanvasEditorHandle implements DocumentEditorHandle {
  #destroyed = false;
  readonly #surface: InkSurfaceHandle;
  readonly #canvas: HTMLCanvasElement;
  readonly #root: Root;
  readonly tools: DocumentEditorTools;

  constructor(
    session: SurfaceSessionBridge,
    parent: HTMLElement,
    assets?: DocumentAssetStore | null,
    presetSettings?: SettingsService | null,
    mountReopen?: MountReopen | null,
    stylusInput?: StylusInputPolicy,
  ) {
    // One narrowly contained synchronous commit: the engine
    // needs the actual canvas/page elements immediately, and createEditor
    // is synchronous. Never during normal rendering or engine updates.
    const skeletonRef: { current: InkSkeleton | null } = { current: null };
    const root = createRoot(parent);
    flushSync(() => {
      root.render(
        createElement(InkSurfaceSkeleton, {
          presentation: 'paint-stage',
          navigationMode: 'standalone',
          skeletonRef,
        }),
      );
    });
    const skeleton = skeletonRef.current;
    if (skeleton === null) throw new Error('ink skeleton failed to commit');
    this.#root = root;
    // Cold-open repair (D, final pass): resolved mount seeds
    // (decode-time bounds, optionally via the derived reopen cache) seed
    // the spatial index without rescanning Ink samples, and the live
    // reopen binding restores validated packed vectors with zero
    // compiles and queues teardown persistence under the revision
    // current at that time. Resolved by the provider.
    const seedBounds = mountReopen?.seeds ?? null;
    const reopen =
      mountReopen?.binding != null
        ? {
            ...mountReopen.binding,
            ...(mountReopen.cache !== null ? { cache: mountReopen.cache } : {}),
          }
        : undefined;
    this.#surface = mountInkSurface({
      model: session.model,
      restrictTextToFrame: true,
      markDirty: () => session.markDirty(),
      host: skeleton,
      stylusInput,
      ...(assets != null ? { assets } : {}),
      ...(presetSettings != null ? { presetSettings } : {}),
      ...(seedBounds != null ? { seedBounds } : {}),
      ...(reopen !== undefined ? { reopen } : {}),
    });
    this.#canvas = skeleton.canvas;
    this.tools = {
      snapshot: () => {
        const contextualAnchor = this.#surface.selectionViewportBounds();
        return {
          context: 'Ink canvas',
          ...(contextualAnchor !== null ? { contextualAnchor } : {}),
          controls: (() => {
            const frame = this.#surface.frameSize();
            return [
              ...buildSurfaceDrawControls(this.#surface, {
                prefix: 'ink',
                tools: INK_DRAW_TOOLS,
              }),
              ...buildSurfaceArrangeControls(this.#surface, {
                prefix: 'ink',
                idPrefix: 'selection.',
                swatches: SWATCHES,
                widths: WIDTH_DOTS,
              }),
              // Grouped surface-text controls: honest
              // selected-text state when available, otherwise the pending
              // creation style — shared with Notebook/Whiteboard.
              ...buildSurfaceTextControls(
                surfaceTextControlIds('ink'),
                this.#surface.textStyleState(),
              ),
              buildSurfaceImageControl(this.#surface, {
                prefix: 'ink',
                icon: 'image',
              }),
              ...buildSurfaceStyleControls(this.#surface, {
                prefix: 'ink',
                swatches: SWATCHES,
                widths: WIDTH_DOTS,
                eraserMin: MIN_ERASER_RADIUS,
                eraserMax: MAX_ERASER_RADIUS,
              }),
              ...buildSurfaceZoomControls(this.#surface, {
                prefix: 'ink',
                min: MIN_ZOOM * 100,
                max: MAX_ZOOM * 100,
              }),
              buildSurfaceFitControl({
                prefix: 'ink',
                label: 'Fit canvas',
                shortLabel: 'Fit',
              }),
              ...surfacePaperControls(session.model, 'ink'),
              {
                ...buildSurfaceExportControl({
                  prefix: 'ink',
                  group: 'view',
                  label: 'Export PNG',
                  shortLabel: 'Export PNG',
                }),
                semanticRole: 'ink.canvas.export',
              },
              ...(frame === null
                ? []
                : [
                    {
                      kind: 'number' as const,
                      id: 'ink.frame-width',
                      semanticRole: 'ink.canvas.width',
                      group: 'canvas',
                      label: 'Canvas width',
                      value: frame.width,
                      min: MIN_FRAME_SIZE,
                      max: MAX_FRAME_SIZE,
                      step: 1,
                      suffix: 'px',
                    },
                    {
                      kind: 'number' as const,
                      id: 'ink.frame-height',
                      semanticRole: 'ink.canvas.height',
                      group: 'canvas',
                      label: 'Canvas height',
                      value: frame.height,
                      min: MIN_FRAME_SIZE,
                      max: MAX_FRAME_SIZE,
                      step: 1,
                      suffix: 'px',
                    },
                  ]),
              // Second-tap settings (slice 8): active-tool property
              // controls for the popover. Unplaced by design — the shared
              // UI reunites them with the active tool button.
              ...buildActiveToolSettingsControls(this.#surface, {
                prefix: 'ink',
                swatches: SWATCHES,
                widths: WIDTH_DOTS,
                eraserMin: MIN_ERASER_RADIUS,
                eraserMax: MAX_ERASER_RADIUS,
              }),
            ];
          })(),
        };
      },
      execute: (id, value) => {
        if (
          executeSurfacePaperControl(session.model, 'ink', id, value, () => {
            session.markDirty();
            this.#surface.refresh();
          })
        )
          return true;
        // Second-tap popover actions (slice 8) route before the main
        // toolbar controls; the surface handle satisfies the host.
        if (
          executeSurfaceToolSettingsControl(
            this.#surface,
            { prefix: 'ink', swatches: SWATCHES, widths: WIDTH_DOTS },
            id,
            value,
          )
        ) {
          return true;
        }
        if (
          executeSurfaceToolbarControl(
            this.#surface,
            {
              prefix: 'ink',
              tools: INK_DRAW_TOOLS,
              arrangeIdPrefix: 'selection.',
            },
            id,
            value,
          )
        ) {
          return true;
        }
        // Grouped surface-text write path: additive
        // role/appearance mutation onto `froglight.text` via the shared
        // engine (one history gesture for a selection, or the pending
        // creation style when no text is selected).
        if (id.startsWith('ink.text.')) {
          return executeInkTextControl(
            {
              textSelectionState: () => this.#surface.textStyleState(),
              setSelectionStyle: (style) => this.#surface.setTextStyle(style),
            },
            id,
            value,
          );
        }
        if (id === 'ink.frame-width' && value !== undefined) {
          const frame = this.#surface.frameSize();
          if (frame !== null)
            this.#surface.resizeFrame(Number(value), frame.height);
          return true;
        }
        if (id === 'ink.frame-height' && value !== undefined) {
          const frame = this.#surface.frameSize();
          if (frame !== null)
            this.#surface.resizeFrame(frame.width, Number(value));
          return true;
        }
        if (id === 'ink.export') {
          this.#surface.exportPng();
          return true;
        }
        return false;
      },
      onDidChange: (listener) => this.#surface.onDidChange(listener),
    };
  }

  focus(): void {
    this.#requireAlive();
    this.#canvas.focus();
  }

  hasFocus(): boolean {
    return !this.#destroyed && document.activeElement === this.#canvas;
  }

  setReadOnly(readOnly: boolean): void {
    this.#requireAlive();
    this.#surface.setReadOnly(readOnly);
  }

  canExecCommand(id: 'undo' | 'redo'): boolean {
    return id === 'undo' ? this.#surface.canUndo() : this.#surface.canRedo();
  }

  execCommand(id: 'undo' | 'redo'): boolean {
    this.#requireAlive();
    return id === 'undo' ? this.#surface.undo() : this.#surface.redo();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    // Unmount first so React cleanly removes the skeleton it owns; the
    // engine teardown below then runs against detached nodes (its own
    // root.remove() becomes a harmless no-op). Reversing the order yanks
    // React-managed DOM out from under the root and corrupts teardown.
    this.#root.unmount();
    this.#surface.destroy();
  }

  /** Test-only selection readback (never used by production UI). */
  selectionIdsForTest(): readonly string[] {
    try {
      return this.#surface.selectionIds();
    } catch {
      return [];
    }
  }

  /** Test-only selection writer (never used by production UI). */
  setSelectionForTest(ids: readonly string[]): void {
    this.#requireAlive();
    this.#surface.setSelection(ids);
  }

  #requireAlive(): void {
    if (this.#destroyed) throw new Error('ink editor handle is destroyed');
  }
}

/**
 * Fallback handle for environments without Canvas 2D. Documents still
 * open/save/reopen through the unchanged session path; editing input is
 * simply unavailable rather than silently broken.
 */
export class HeadlessInkEditorHandle implements DocumentEditorHandle {
  #destroyed = false;

  constructor(session: { markDirty(): void }) {
    void session;
  }

  focus(): void {
    this.#requireAlive();
  }

  hasFocus(): boolean {
    return !this.#destroyed;
  }

  setReadOnly(readOnly: boolean): void {
    this.#requireAlive();
    void readOnly;
  }

  execCommand(): boolean {
    return false;
  }

  destroy(): void {
    this.#destroyed = true;
  }

  #requireAlive(): void {
    if (this.#destroyed) throw new Error('ink editor handle is destroyed');
  }
}

export class InkDocumentEditorProvider implements DocumentEditorProvider {
  readonly id = 'ink';
  readonly kindIds = [documentKindId(INK_PAGE_KIND_ID)] as const;
  /**
   * Derived reopen cache pool: spans opens from this provider
   * instance so a document reopen reuses validated bounds/geometry.
   * Bounded, revision-keyed, dirty-gated, and backed by host-owned
   * durable storage when supplied; never authoritative (decode seeds
   * always fill gaps).
   */
  readonly #reopen: DerivedReopenStore;

  constructor(
    deps: { derivedCacheStorage?: DerivedCacheStoragePort | null } = {},
  ) {
    this.#reopen = new DerivedReopenStore(
      undefined,
      deps.derivedCacheStorage ?? null,
      { createPacker: createDerivedCachePackWorker },
    );
  }

  createEditor(input: {
    session: unknown;
    parent: unknown;
    assets?: DocumentAssetStore | null;
    /** Application settings for shared tool presets.*/
    presetSettings?: SettingsService | null;
    stylusInput?: StylusInputPolicy;
  }): DocumentEditorHandle {
    const session = input.session as SurfaceSessionBridge;
    if (
      hasCanvas2d() &&
      typeof input.parent === 'object' &&
      input.parent !== null &&
      typeof (input.parent as HTMLElement).appendChild === 'function'
    ) {
      return new InkPageCanvasEditorHandle(
        session,
        input.parent as HTMLElement,
        input.assets ?? null,
        input.presetSettings ?? null,
        resolveMountReopen(this.#reopen, {
          openMetadata: session.openMetadata,
          document: session.document,
          getContentRevision: () => session.contentRevision ?? null,
          isDirty: () => session.dirty === true,
        }),
        input.stylusInput,
      );
    }
    return new HeadlessInkEditorHandle(session);
  }
}
