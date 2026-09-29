/**
 * Whiteboard editor provider — infinite surface document.
 *
 * Whiteboards reuse the shared surface foundation so there is no second
 * canvas engine. The provider owns the DOM binding and whiteboard-specific
 * chrome (card tool, infinite navigation) while canonical bytes,
 * composition, and derived state stay in `@froglight/foundation`.
 */

import { createDerivedCachePackWorker } from '@froglight/editor-ink';
import {
  executeSurfacePaperControl,
  surfacePaperControls,
} from '@froglight/editor-ink';
import type {
  StylusInputPolicy,
  DerivedCacheStoragePort,
  DocumentAssetStore,
  DocumentEditorHandle,
  DocumentEditorProvider,
  SettingsService,
} from '@froglight/foundation';
import { documentKindId } from '@froglight/foundation';
import type { SurfaceModel } from '@froglight/foundation';
import { cardObject } from '@froglight/foundation';
import {
  INK_TOOL_IDS,
  InkSurfaceSkeleton,
  mountInkSurface,
  resolveMountReopen,
  twoPointShapeTool,
  type InkSkeleton,
  type InkSurfaceHandle,
  type MountReopen,
  type SurfaceLiveStyles,
} from '@froglight/editor-ink';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  buildActiveToolSettingsControls,
  buildSurfaceDrawControls,
  buildSurfaceFitControl,
  buildSurfaceImageControl,
  buildSurfaceStyleControls,
  buildSurfaceArrangeControls,
  buildSurfaceTextControls,
  buildSurfaceZoomControls,
  createSharedSurfaceDrawTools,
  createSharedSurfaceEraserTools,
  executeSurfaceTextControl,
  executeSurfaceToolbarControl,
  executeSurfaceToolSettingsControl,
  DerivedReopenStore,
  normalizeBox,
  SURFACE_SHARED_SWATCHES,
  SURFACE_SHARED_WIDTHS,
  SURFACE_TOOL_IDS,
  surfaceTextControlIds,
  type PenStyleRef,
  type SurfaceTextExecuteHost,
  type SurfaceToolbarDrawTool,
} from '@froglight/foundation';
import type { CardItem, SurfaceTool } from '@froglight/foundation';

const WHITEBOARD_KIND_ID = 'froglight.whiteboard';

export const WHITEBOARD_TOOL_IDS = {
  select: SURFACE_TOOL_IDS.select,
  pen: SURFACE_TOOL_IDS.pen,
  fountain: SURFACE_TOOL_IDS.fountain,
  brush: SURFACE_TOOL_IDS.brush,
  pencil: SURFACE_TOOL_IDS.pencil,
  highlighter: SURFACE_TOOL_IDS.highlighter,
  eraser: SURFACE_TOOL_IDS.eraser,
  lasso: SURFACE_TOOL_IDS.lasso,
  text: INK_TOOL_IDS.text,
  card: 'froglight.whiteboard.card',
  rect: INK_TOOL_IDS.rect,
  ellipse: INK_TOOL_IDS.ellipse,
  line: INK_TOOL_IDS.line,
} as const;

function hasCanvas2d(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const probe = document.createElement('canvas');
    const ctx = probe.getContext('2d');
    return (
      ctx !== null &&
      typeof (ctx as unknown as { fillRect?: unknown }).fillRect === 'function'
    );
  } catch {
    return false;
  }
}

interface WhiteboardSession {
  readonly model: SurfaceModel;
  readonly openMetadata?: Readonly<Record<string, unknown>>;
  readonly document?: { readonly documentId?: unknown };
  /** Live session revision (property read at each cache use). */
  readonly contentRevision?: string | null;
  /** Live session dirty flag (property read at each cache use). */
  readonly dirty?: boolean;
  markDirty(): void;
}

// ---------------------------------------------------------------------------
// Whiteboard-specific tools — registered alongside the ink defaults.
// Card is the whiteboard signature: a framed text container. It is built on
// the shared two-point shape seam (`twoPointShapeTool`), so gesture capture,
// tap detection, hit-testing, culling, and viewport math stay consistent
// with rect/ellipse/line. Only the commit (minimum sizes plus a tap default
// card) and the card preview are whiteboard-specific.
// ---------------------------------------------------------------------------

/** Minimum committed card size in surface units. */
const CARD_MIN_WIDTH = 40;
const CARD_MIN_HEIGHT = 32;

/** Tap default card size (Paint behavior: a click drops a usable card). */
const CARD_TAP_WIDTH = 200;
const CARD_TAP_HEIGHT = 120;

function clampCardBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  return {
    x: box.x,
    y: box.y,
    width: Math.max(box.width, CARD_MIN_WIDTH),
    height: Math.max(box.height, CARD_MIN_HEIGHT),
  };
}

/**
 * Whiteboard Card tool sharing live styles (review slice 4, Option A).
 *
 * The generic `whiteboard.color` toolbar control maps to `CardGeometry.color`
 * (card text color) so the control has a canonical effect on newly created
 * cards. The factory receives the same live `pen` ref as the core tools, so
 * toolbar color changes affect actual created objects.
 */
export function createCardTool(penStyle: PenStyleRef): SurfaceTool {
  return twoPointShapeTool({
    toolId: WHITEBOARD_TOOL_IDS.card,
    penStyle,
    tapSize: { width: CARD_TAP_WIDTH, height: CARD_TAP_HEIGHT },
    commit: (id, a, b, style) => {
      const box = clampCardBox(normalizeBox(a, b));
      return cardObject(id, {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        text: 'New card',
        ...(style.color !== undefined ? { color: style.color } : {}),
      });
    },
    previewItem: (objectId, a, b, style): CardItem => {
      const box = clampCardBox(normalizeBox(a, b));
      return {
        kind: 'card',
        objectId,
        bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
        rotation: 0,
        text: 'Card',
        size: 14,
        ...(style.color !== undefined ? { color: style.color } : {}),
      };
    },
  });
}

/** Extra-tools factory for `mountInkSurface` sharing live styles. */
export function whiteboardExtraTools(
  styles: SurfaceLiveStyles,
): readonly SurfaceTool[] {
  return [createCardTool(styles.pen)];
}

// ---------------------------------------------------------------------------
// Whiteboard surface handle — wraps `mountInkSurface` with whiteboard chrome.
// ---------------------------------------------------------------------------

/**
 * Declared Whiteboard toolbar profile for the shared surface builder: the
 * twelve canonical Surface draw tools with Whiteboard's short control-id
 * keys (`whiteboard.tool.<key>`) mapped to engine tool ids, with the single
 * eraser replaced by two modes with short keys. Labels,
 * icons, groups, coarse roles, semantic roles, and ordering come from the
 * shared family tables so Whiteboard cannot diverge from Ink or Notebook;
 * the short keys preserve Whiteboard's provider-owned control ids
 * (referenced by placement predicates and existing hosts). The
 * `surface.erase.tool` composition id itself is never renamed — it stays
 * dormant for persisted overrides/old hosts while providers emit the three
 * fixed-mode tools over the single eraser engine.
 */
const WHITEBOARD_DRAW_BASE: readonly SurfaceToolbarDrawTool[] =
  createSharedSurfaceDrawTools(
    {
      pen: WHITEBOARD_TOOL_IDS.pen,
      fountain: WHITEBOARD_TOOL_IDS.fountain,
      brush: WHITEBOARD_TOOL_IDS.brush,
      pencil: WHITEBOARD_TOOL_IDS.pencil,
      highlighter: WHITEBOARD_TOOL_IDS.highlighter,
      eraser: WHITEBOARD_TOOL_IDS.eraser,
      select: WHITEBOARD_TOOL_IDS.select,
      lasso: WHITEBOARD_TOOL_IDS.lasso,
      line: WHITEBOARD_TOOL_IDS.line,
      rectangle: WHITEBOARD_TOOL_IDS.rect,
      triangle: INK_TOOL_IDS.triangle,
      diamond: INK_TOOL_IDS.diamond,
      ellipse: WHITEBOARD_TOOL_IDS.ellipse,
      text: WHITEBOARD_TOOL_IDS.text,
    },
    {
      pen: 'pen',
      fountain: 'fountain',
      brush: 'brush',
      pencil: 'pencil',
      highlighter: 'highlighter',
      eraser: 'eraser',
      select: 'select',
      lasso: 'lasso',
      line: 'line',
      rectangle: 'rect',
      ellipse: 'ellipse',
      triangle: 'triangle',
      diamond: 'diamond',
      text: 'text',
    },
  );

const WHITEBOARD_ERASER_TOOLS: readonly SurfaceToolbarDrawTool[] =
  createSharedSurfaceEraserTools(WHITEBOARD_TOOL_IDS.eraser, {
    stroke: 'eraser-stroke',
    precision: 'eraser-precision',
  });

const WHITEBOARD_DRAW_TOOLS: readonly SurfaceToolbarDrawTool[] = [
  ...WHITEBOARD_DRAW_BASE.slice(0, 5),
  ...WHITEBOARD_ERASER_TOOLS,
  ...WHITEBOARD_DRAW_BASE.slice(6),
  {
    key: 'card',
    toolId: WHITEBOARD_TOOL_IDS.card,
    label: 'Card',
    icon: 'blocks',
    group: 'insert',
    toolRole: 'shape',
    semanticRole: 'surface.insert.card',
  },
];

/**
 * Grouped surface-text execute.
 *
 * Thin `whiteboard` dialect over the shared `executeSurfaceTextControl`
 * (foundation owns the additive `setSelectionStyle` mapping; the shared
 * engine owns selection mutation and the pending style for newly placed text.
 * `froglight.card` text stays distinct from
 * `froglight.text` (card text is not styled here).
 */
export function executeWhiteboardTextControl(
  host: SurfaceTextExecuteHost,
  id: string,
  value: unknown,
): boolean {
  return executeSurfaceTextControl(host, 'whiteboard', id, value);
}

/** Shared family palette/fast widths for style controls and settings popovers. */
const WHITEBOARD_SWATCHES = SURFACE_SHARED_SWATCHES;
const WHITEBOARD_WIDTHS = SURFACE_SHARED_WIDTHS;

class WhiteboardCanvasHandle implements DocumentEditorHandle {
  readonly #surface: InkSurfaceHandle;
  readonly #root: Root;
  readonly #session: WhiteboardSession;
  #destroyed = false;

  constructor(
    session: WhiteboardSession,
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
    if (skeleton === null)
      throw new Error('whiteboard skeleton failed to commit');
    this.#root = root;
    this.#session = session;
    // Cold-open repair (D, final pass): resolved mount seeds
    // (decode-time bounds, optionally via the derived reopen cache) plus
    // the live reopen binding for packed-vector restore and teardown
    // persistence. Resolved by the provider; the mount seeds without
    // rescanning Ink samples.
    // Core registry is owned by `mountInkSurface` with live style refs;
    // Card contributes through the extra-tools seam sharing those refs.
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
      markDirty: () => session.markDirty(),
      host: skeleton,
      stylusInput,
      presentation: 'paint-stage',
      navigationMode: 'standalone',
      frameResizable: false,
      extraTools: whiteboardExtraTools,
      ...(assets != null ? { assets } : {}),
      ...(presetSettings != null ? { presetSettings } : {}),
      ...(seedBounds !== null ? { seedBounds } : {}),
      ...(reopen !== undefined ? { reopen } : {}),
    });
  }

  focus(): void {
    this.#surface.root.focus();
  }

  hasFocus(): boolean {
    return document.activeElement === this.#surface.root;
  }

  setReadOnly(readOnly: boolean): void {
    this.#surface.setReadOnly(readOnly);
  }

  canExecCommand(id: 'undo' | 'redo'): boolean {
    return id === 'undo' ? this.#surface.canUndo() : this.#surface.canRedo();
  }

  execCommand(id: 'undo' | 'redo'): boolean {
    return id === 'undo' ? this.#surface.undo() : this.#surface.redo();
  }

  /**
   * Exact reveal seam: the opaque address is a surface
   * object id passed verbatim. On hit the exact object is selected and
   * the method returns true; unknown or empty addresses return false
   * without moving selection. Selection only — the viewport is left
   * unchanged, so an off-viewport hit still reports true without becoming
   * visible. Focus-neutral and ephemeral: never mutates canonical bytes,
   * never steals focus (the controller focuses separately unless
   * `preserveFocus`).
   */
  revealAddress(address: string): boolean {
    if (this.#destroyed) return false;
    if (typeof address !== 'string' || address === '') return false;
    try {
      if (this.#session.model.objects[address] === undefined) return false;
    } catch {
      return false;
    }
    try {
      this.#surface.setSelection([address]);
    } catch {
      return false;
    }
    return true;
  }

  /** Test-only selection readback (never used by production UI). */
  getSelectionIdsForTest(): readonly string[] {
    try {
      return this.#surface.selectionIds();
    } catch {
      return [];
    }
  }

  /** Test-only selection writer (never used by production UI). */
  setSelectionForTest(ids: readonly string[]): void {
    if (this.#destroyed) return;
    try {
      this.#surface.setSelection(ids);
    } catch {
      // Selection write never breaks teardown paths.
    }
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

  // Toolbar integration — the React shell polls `tools.snapshot()` and
  // forwards `tools.execute(id, value)` from the two-tier tray.
  // Snapshot is plain data; no editor types cross the seam. Draw, style,
  // zoom, image, and fit controls come from the shared surface builder;
  // Whiteboard contributes only the shared family profile (short keys) plus
  // its Card addition. Card is the sole Whiteboard-specific draw tool.
  readonly tools: DocumentEditorHandle['tools'] = {
    snapshot: () => {
      const contextualAnchor = this.#surface.selectionViewportBounds();
      return {
        context: 'Whiteboard',
        ...(contextualAnchor !== null ? { contextualAnchor } : {}),
        controls: [
          ...buildSurfaceDrawControls(this.#surface, {
            prefix: 'whiteboard',
            tools: WHITEBOARD_DRAW_TOOLS,
          }),
          buildSurfaceImageControl(this.#surface, {
            prefix: 'whiteboard',
            icon: 'image',
          }),
          ...buildSurfaceArrangeControls(this.#surface, {
            prefix: 'whiteboard',
            idPrefix: 'selection.',
            swatches: WHITEBOARD_SWATCHES,
            widths: WHITEBOARD_WIDTHS,
          }),
          // Grouped surface-text controls: honest selection
          // selected-text state when available, otherwise the pending
          // creation style — shared with Ink/Notebook.
          // `froglight.card` text stays distinct (unstyled here).
          ...buildSurfaceTextControls(
            surfaceTextControlIds('whiteboard'),
            this.#surface.textStyleState(),
          ),
          ...buildSurfaceStyleControls(this.#surface, {
            prefix: 'whiteboard',
            swatches: WHITEBOARD_SWATCHES,
            widths: WHITEBOARD_WIDTHS,
          }),
          ...buildSurfaceZoomControls(this.#surface, {
            prefix: 'whiteboard',
            resetLabel: (zoom) =>
              `Whiteboard zoom ${zoom}%, activate to reset to 100%`,
          }),
          buildSurfaceFitControl({
            prefix: 'whiteboard',
            label: 'Fit board',
            shortLabel: 'Fit',
          }),
          {
            kind: 'status',
            id: 'whiteboard.canvas-mode',
            semanticRole: 'surface.canvas.mode',
            group: 'canvas',
            label: 'Infinite canvas',
          },
          ...surfacePaperControls(this.#session.model, 'whiteboard'),
          // Second-tap settings (slice 8): active-tool property
          // controls for the popover. Unplaced by design — the shared
          // UI reunites them with the active tool button.
          ...buildActiveToolSettingsControls(this.#surface, {
            prefix: 'whiteboard',
            swatches: WHITEBOARD_SWATCHES,
            widths: WHITEBOARD_WIDTHS,
          }),
        ],
      };
    },
    execute: (id: string, value?: string): boolean => {
      if (
        executeSurfacePaperControl(
          this.#session.model,
          'whiteboard',
          id,
          value,
          () => {
            this.#session.markDirty();
            this.#surface.refresh();
          },
        )
      )
        return true;
      // Second-tap popover actions (slice 8) route before the main
      // toolbar controls; the surface handle satisfies the host.
      if (
        executeSurfaceToolSettingsControl(
          this.#surface,
          {
            prefix: 'whiteboard',
            swatches: WHITEBOARD_SWATCHES,
            widths: WHITEBOARD_WIDTHS,
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
      if (id.startsWith('whiteboard.text.')) {
        return executeWhiteboardTextControl(
          {
            textSelectionState: () => this.#surface.textStyleState(),
            setSelectionStyle: (style) => this.#surface.setTextStyle(style),
          },
          id,
          value,
        );
      }
      return executeSurfaceToolbarControl(
        this.#surface,
        {
          prefix: 'whiteboard',
          tools: WHITEBOARD_DRAW_TOOLS,
          arrangeIdPrefix: 'selection.',
        },
        id,
        value,
      );
    },
    onDidChange: (listener: () => void) => this.#surface.onDidChange(listener),
  };
}

class HeadlessWhiteboardHandle implements DocumentEditorHandle {
  #destroyed = false;
  #focused = false;
  readonly #session: WhiteboardSession;

  constructor(session: WhiteboardSession) {
    this.#session = session;
  }

  focus(): void {
    if (this.#destroyed) throw new Error('whiteboard handle is destroyed');
    this.#focused = true;
  }

  hasFocus(): boolean {
    return !this.#destroyed && this.#focused;
  }

  setReadOnly(_readOnly: boolean): void {
    if (this.#destroyed) throw new Error('whiteboard handle is destroyed');
  }

  execCommand(): boolean {
    return false;
  }

  /**
   * Resolve-only reveal seam: returns true iff the
   * opaque address names an object in the canonical surface model.
   * Never focuses, never mutates, never throws on unknown addresses.
   */
  revealAddress(address: string): boolean {
    if (this.#destroyed) return false;
    if (typeof address !== 'string' || address === '') return false;
    try {
      return this.#session.model.objects[address] !== undefined;
    } catch {
      return false;
    }
  }

  destroy(): void {
    this.#destroyed = true;
  }
}

export class WhiteboardDocumentEditorProvider
  implements DocumentEditorProvider
{
  readonly id = 'whiteboard';
  readonly kindIds = [documentKindId(WHITEBOARD_KIND_ID)] as const;
  /**
   * Derived reopen cache pool: spans opens from this provider
   * instance so a document reopen reuses validated bounds/geometry.
   * Bounded, revision-keyed, dirty-gated, and backed by host-owned
   * durable storage when supplied; never authoritative.
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
    const session = input.session as WhiteboardSession;
    if (
      hasCanvas2d() &&
      typeof input.parent === 'object' &&
      input.parent !== null &&
      typeof (input.parent as HTMLElement).appendChild === 'function'
    ) {
      return new WhiteboardCanvasHandle(
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
    return new HeadlessWhiteboardHandle(session);
  }
}
