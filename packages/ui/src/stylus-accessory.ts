/**
 * Stylus accessory binder (hardened).
 *
 * Framework-free core behind the `useStylusAccessory` shell hook:
 * subscribes to the trusted `StylusService` and translates accessory
 * actions into shell behavior without editor-library or DOM types.
 *
 * - Pencil squeeze follows the system preferred action. Palette actions
 *   open near the Pencil tip (or focus colors/attributes); switchEraser
 *   and switchPrevious execute once on began; ignore does nothing.
 *   Phased palette squeezes track the anchor through changed and settle
 *   on ended. Duplicate began and stray ended events are absorbed.
 *   Phaseless events are one complete action. Outside dismissal and
 *   pane/document changes reconcile through `handlePaletteClosed` /
 *   `handlePaneChanged`.
 *   Apple Pencil double-tap keeps separate semantics
 *   (persistent `switchEraser`, history `switchPrevious`, palette focus
 *   opens, `ignore`/`unknown` no-ops, `runSystemShortcut` diagnostics).
 * - Core palette tools come from `DocumentToolSnapshot` even with zero
 *   registry contributions; `StylusMenuRegistry` entries merge into a
 *   "More" section and never suppress core tools.
 * - Momentary physical eraser (`eraser` active/inactive) keeps the
 *   select-on-press/restore-on-release behavior; Apple Pencil double-tap
 *   `switchEraser` is a separate persistent toggle (pen ↔ eraser).
 * - Preferred actions route through `StylusPreferredActionController`
 *   for both double-tap and squeeze. Phased squeeze executes at began only.
 *   `ignore`/`unknown` double-tap are no-ops and `runSystemShortcut`
 *   double-tap stays with the system (diagnostics only).
 *
 * Tool routing stays provider-neutral: matching runs on semantic
 * `DocumentToolControl` metadata (`role = surface-tool`, `toolRole`)
 * surfaced through `WorkbenchEditorToolsPort`, never on editor handles.
 */

import type {
  DocumentToolControl,
  DocumentToolSnapshot,
  StylusAction,
  StylusPreferredAction,
  StylusService,
  StylusViewportAnchor,
} from '@froglight/foundation';
import type { MenuEntry } from './menu.js';
import type {
  StylusMenuContext,
  StylusMenuRegistry,
} from './stylus-menu-registry.js';
import {
  findActiveSurfaceToolId,
  findSurfaceEraserControlId,
} from './stylus-accessory-helpers.js';
import { StylusPreferredActionController } from './stylus-preferred-action.js';
import {
  buildStylusPaletteModel,
  type StylusPaletteFocusMode,
  type StylusPaletteModel,
} from './stylus-palette-model.js';
import type {
  DocumentToolbarContext,
  DocumentToolbarRegistry,
} from './document-toolbar-registry.js';
import {
  assembleOwnedPool,
  shellHistoryOwnedControls,
} from './toolbar/placement-resolver.js';
import {
  resolveToolbarComposition,
  type ToolbarCompositionRegistry,
} from './toolbar/composition-registry.js';

export {
  findActiveSurfaceToolId,
  findExplicitActiveSurfaceToolId,
  findExplicitSurfaceEraserControlId,
  findSurfaceEraserControlId,
  isExplicitSurfaceEraserControl,
  isSemanticSurfaceToolControl,
  isSurfaceEraserControl,
  isSurfaceEraserControlId,
  isSurfaceToolControlId,
} from './stylus-accessory-helpers.js';

/** Narrow tools port: the binder never sees the aggregate controller. */
export interface StylusAccessoryToolsPort {
  editorToolSnapshot(pane?: string): DocumentToolSnapshot | null;
  executeEditorTool(
    pane: string,
    id: string,
    value?: string,
  ): boolean | Promise<boolean>;
  /**
   * Provider tool-state changes refresh an open squeeze
   * palette in place via `refreshSqueezePalette`. Optional so legacy
   * doubles stay valid; absent means no push (no polling, no second
   * store). Subscribed once per binder lifetime via `#registryDisposers`.
   */
  onDidChange?: (listener: () => void) => { dispose(): void };
}

/** Narrow undo/redo port for palette history (optional; palette degrades). */
export interface StylusAccessoryCommandsPort {
  canExecEditorCommand(command: 'undo' | 'redo', pane?: string): boolean;
  execEditorCommand(command: 'undo' | 'redo', pane?: string): boolean;
}

export interface StylusAccessoryMenuAnchor {
  readonly x: number;
  readonly y: number;
}

export interface StylusPaletteHandle {
  updateAnchor(anchor: StylusAccessoryMenuAnchor): void;
  /**
   * Repairs 4+5 live model: replace the presented model in place without
   * remounting the panel (opening anchor preserved). Optional so legacy
   * doubles stay valid; the binder guards and treats a missing channel as
   * a no-op push.
   */
  updateModel?(model: StylusPaletteModel): void;
  close(): void;
  readonly closed: boolean;
}

export interface StylusAccessoryDeps {
  readonly service: StylusService;
  readonly menuRegistry: StylusMenuRegistry | null;
  readonly toolbarComposition?: ToolbarCompositionRegistry | null;
  /**
   * Document toolbar contributions (trusted + community via DTO + broker).
   * When present, the squeeze palette assembles the same owned pool as the
   * normal toolbar (provider + shell + contributions) and resolves the
   * squeeze projection against it, so `showInSqueeze` contributions appear
   * with their original owner. Absent (legacy callers/tests) degrades to
   * provider snapshot controls only.
   */
  readonly toolbarRegistry?:
    | (Pick<DocumentToolbarRegistry, 'entries'> &
        Partial<Pick<DocumentToolbarRegistry, 'onDidChange'>>)
    | null;
  readonly slots?: import('./stylus-palette-model.js').StylusPaletteModelOptions['slots'];
  readonly tools: StylusAccessoryToolsPort;
  readonly focusedPane: () => string | null;
  readonly menuContext: () => StylusMenuContext | null;
  readonly showMenu: (
    entries: readonly MenuEntry[],
    anchor: StylusAccessoryMenuAnchor,
  ) => void;
  readonly menuAnchor: () => StylusAccessoryMenuAnchor;
  /** Dedicated spatial palette presentation (React owns the DOM). */
  readonly showPalette?: (
    model: StylusPaletteModel,
    anchor: StylusAccessoryMenuAnchor,
  ) => StylusPaletteHandle;
  /** Latest observed pen PointerEvent position (no native hover stream). */
  readonly lastPenAnchor?: () => StylusViewportAnchor | null;
  /** Focused surface center fallback. */
  readonly surfaceCenter?: () => StylusViewportAnchor | null;
  readonly commands?: StylusAccessoryCommandsPort | null;
  readonly diagnostics?: (message: string) => void;
}

/**
 * Toolbar context for owned-pool assembly from the squeeze menu context.
 * Null when the squeeze context lacks the identity the toolbar registry
 * needs (pane/document/kind); callers then degrade to provider-only.
 */
export function stylusToolbarContextFor(
  pane: string | null,
  menu: StylusMenuContext | null,
  editor: DocumentToolSnapshot | null,
): DocumentToolbarContext | null {
  if (pane === null) return null;
  if (menu?.kindId == null || menu?.documentId == null) return null;
  return {
    pane,
    documentId: menu.documentId,
    kindId: menu.kindId,
    editor,
  };
}

interface EraserSelection {
  readonly pane: string;
  readonly previousControlId: string | null;
  readonly requestId: number;
}

type SqueezeSession =
  | 'idle'
  | 'tracking-open'
  | 'tracking-close'
  | 'palette-active';

/** Max diagnostic message length: sanitized + bounded, never stack/dumps. */
const MAX_SQUEEZE_DIAGNOSTIC_CHARS = 200;

function sanitizeDiagnosticDetail(message: string): string {
  // First line only (drops `stack:`/dump tails), collapse control
  // whitespace, then bound the length. Never emits stack traces or object
  // dumps; callers prefix with a stable `squeeze <area> ... failed:` label.
  const firstLine = message.split('\n', 1)[0] ?? '';
  const collapsed = firstLine.replace(/[\r\t]+/g, ' ').trim();
  if (collapsed.length <= MAX_SQUEEZE_DIAGNOSTIC_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_SQUEEZE_DIAGNOSTIC_CHARS)}…`;
}

function truncateDiagnostic(message: string): string {
  return sanitizeDiagnosticDetail(message);
}

function focusModeFor(
  preferredAction: StylusPreferredAction | undefined,
): StylusPaletteFocusMode {
  if (preferredAction === 'showColorPalette') return 'color';
  if (preferredAction === 'showInkAttributes') return 'attributes';
  return 'full';
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}

function safeSnapshot(
  read: () => DocumentToolSnapshot | null,
  onThrow?: (error: unknown) => void,
): DocumentToolSnapshot | null {
  try {
    return read();
  } catch (error) {
    onThrow?.(error);
    return null;
  }
}

/**
 * Structural equality for the live squeeze model: true when a
 * rebuild would present identically (no `updateModel` push, no remount).
 * Compares the presented surface — tools (id/label/shortLabel/icon/active/
 * disabled/toolRole/semanticRole/activationRole/owner), quick styles
 * (id/label/value/options/min/max/step), history, focus, owned pool, and
 * More visible fields (label/icon/shortcut/danger/disabled/checked) —
 * never callback/control identity objects or callbacks. Owner/activation
 * changes are presentation-visible (routing + tiering) so they must push.
 * Icon, short-label, and style-section label changes must also push, or the
 * open palette would keep stale presentation data.
 * are visible (section header + aria-label) so they must push too.
 */
function ownerKey(
  owner:
    | {
        readonly kind: string;
        readonly contributionId?: string;
        readonly command?: string;
      }
    | undefined,
): string {
  if (owner === undefined) return 'none';
  if (owner.kind === 'contribution')
    return `contribution:${owner.contributionId ?? ''}`;
  if (owner.kind === 'shell') return `shell:${owner.command ?? ''}`;
  return owner.kind;
}

function menuEntryVisibleEqual(a: MenuEntry, b: MenuEntry): boolean {
  if (a === 'separator' || b === 'separator') return a === b;
  // Presentation-visible scalars only — never `run` (callback identity).
  return (
    (a.label ?? null) === (b.label ?? null) &&
    (a.icon ?? null) === (b.icon ?? null) &&
    (a.shortcut ?? null) === (b.shortcut ?? null) &&
    (a.danger ?? false) === (b.danger ?? false) &&
    (a.disabled ?? false) === (b.disabled ?? false) &&
    (a.checked ?? false) === (b.checked ?? false)
  );
}

function squeezeModelsEqual(
  a: StylusPaletteModel,
  b: StylusPaletteModel,
): boolean {
  if (a === b) return true;
  if (a.activeToolId !== b.activeToolId) return false;
  if (a.focusMode !== b.focusMode) return false;
  if (a.canUndo !== b.canUndo || a.canRedo !== b.canRedo) return false;
  if (a.tools.length !== b.tools.length) return false;
  for (let i = 0; i < a.tools.length; i += 1) {
    const ta = a.tools[i];
    const tb = b.tools[i];
    if (ta === undefined || tb === undefined) return false;
    if (
      ta.id !== tb.id ||
      ta.label !== tb.label ||
      (ta.shortLabel ?? null) !== (tb.shortLabel ?? null) ||
      (ta.icon ?? null) !== (tb.icon ?? null) ||
      ta.active !== tb.active ||
      (ta.disabled ?? false) !== (tb.disabled ?? false) ||
      (ta.toolRole ?? null) !== (tb.toolRole ?? null) ||
      (ta.semanticRole ?? null) !== (tb.semanticRole ?? null) ||
      (ta.activationRole ?? null) !== (tb.activationRole ?? null) ||
      ownerKey(
        ta.owner as
          | {
              readonly kind: string;
              readonly contributionId?: string;
              readonly command?: string;
            }
          | undefined,
      ) !==
        ownerKey(
          tb.owner as
            | {
                readonly kind: string;
                readonly contributionId?: string;
                readonly command?: string;
              }
            | undefined,
        )
    ) {
      return false;
    }
  }
  const colorEqual =
    (a.color === null) === (b.color === null) &&
    (a.color === null ||
      b.color === null ||
      (a.color.id === b.color.id &&
        a.color.label === b.color.label &&
        a.color.value === b.color.value &&
        a.color.options.length === b.color.options.length &&
        a.color.options.every(
          (option, index) => option === b.color?.options[index],
        )));
  if (!colorEqual) return false;
  const widthEqual =
    (a.width === null) === (b.width === null) &&
    (a.width === null ||
      b.width === null ||
      (a.width.id === b.width.id &&
        a.width.label === b.width.label &&
        a.width.value === b.width.value &&
        a.width.options.length === b.width.options.length &&
        a.width.options.every(
          (option, index) =>
            option.value === b.width?.options[index]?.value &&
            option.label === b.width?.options[index]?.label,
        )));
  if (!widthEqual) return false;
  const eraserEqual =
    (a.eraserSize === null) === (b.eraserSize === null) &&
    (a.eraserSize === null ||
      b.eraserSize === null ||
      (a.eraserSize.id === b.eraserSize.id &&
        a.eraserSize.label === b.eraserSize.label &&
        a.eraserSize.value === b.eraserSize.value &&
        a.eraserSize.min === b.eraserSize.min &&
        a.eraserSize.max === b.eraserSize.max &&
        a.eraserSize.step === b.eraserSize.step));
  if (!eraserEqual) return false;
  const stylesEqual =
    (a.styles === null) === (b.styles === null) &&
    (a.styles === null ||
      b.styles === null ||
      (a.styles.id === b.styles.id &&
        a.styles.label === b.styles.label &&
        a.styles.value === b.styles.value &&
        a.styles.options.length === b.styles.options.length &&
        a.styles.options.every(
          (option, index) =>
            option.value === b.styles?.options[index]?.value &&
            option.label === b.styles?.options[index]?.label,
        )));
  if (!stylesEqual) return false;
  // routing is presentation-visible — an owner swap on the same id
  // (provider→contribution, contribution→contribution) must push, otherwise
  // the palette would execute via the stale owner. Compare the backing
  // `owned` pool as a cheap fingerprint (ids + owner keys in palette order).
  const ownedA = a.owned ?? [];
  const ownedB = b.owned ?? [];
  if (ownedA.length !== ownedB.length) return false;
  for (let i = 0; i < ownedA.length; i += 1) {
    const oa = ownedA[i];
    const ob = ownedB[i];
    if (oa === undefined || ob === undefined) return false;
    if (oa.control.id !== ob.control.id) return false;
    if (
      ownerKey(
        oa.owner as {
          readonly kind: string;
          readonly contributionId?: string;
          readonly command?: string;
        },
      ) !==
      ownerKey(
        ob.owner as {
          readonly kind: string;
          readonly contributionId?: string;
          readonly command?: string;
        },
      )
    ) {
      return false;
    }
  }
  if (a.contributions.length !== b.contributions.length) return false;
  for (let i = 0; i < a.contributions.length; i += 1) {
    const ca = a.contributions[i];
    const cb = b.contributions[i];
    if (ca === undefined || cb === undefined) return false;
    if (!menuEntryVisibleEqual(ca, cb)) return false;
  }
  return true;
}

function safePane(
  read: () => string | null,
  onThrow?: (error: unknown) => void,
): string | null {
  try {
    return read();
  } catch (error) {
    onThrow?.(error);
    return null;
  }
}

function safeContext(
  read: () => StylusMenuContext | null,
  onThrow?: (error: unknown) => void,
): StylusMenuContext | null {
  try {
    return read();
  } catch (error) {
    onThrow?.(error);
    return null;
  }
}

function safeEntries<T>(read: () => T, onThrow?: (error: unknown) => void): T {
  try {
    return read();
  } catch (error) {
    // Registry failures degrade to empty contributions, never a crash.
    onThrow?.(error);
    return [] as unknown as T;
  }
}

function safeFlag(
  read: () => boolean,
  onThrow?: (error: unknown) => void,
): boolean {
  try {
    return read();
  } catch (error) {
    onThrow?.(error);
    return false;
  }
}

export class StylusAccessoryBinder {
  readonly #deps: StylusAccessoryDeps;
  readonly #unsubscribe: () => void;
  readonly #preferred = new StylusPreferredActionController();
  #pending: EraserSelection | null = null;
  #disposed = false;
  #eraserRequested = false;
  #operationGeneration = 0;
  #persistentGeneration = 0;

  #squeeze: SqueezeSession = 'idle';
  #squeezePalette: StylusPaletteHandle | null = null;
  #squeezeOwned = false;
  #squeezePane: string | null = null;
  /**
   * Absolute-toggle session: the in-flight phased gesture is encoded
   * directly in `#squeeze` (`tracking-open` = began opened/attempted,
   * `tracking-close` = began closed). `began` performs the gesture's
   * single toggle; `changed` never toggles; `ended`/`cancelled` only
   * settle. A `began` arriving while tracking is a duplicate platform
   * frame and is absorbed. Phaseless squeezes never enter tracking —
   * they toggle atomically and settle to `palette-active`/`idle`.
   */
  /**
   * Re-entrancy guard for overlay self-close notification:
   * binder-initiated closes (`#closeSqueezePalette`) do their own
   * bookkeeping, so the synchronous `onClose` echo from the overlay handle
   * is suppressed; only genuine outside/Escape closes reach
   * `handlePaletteClosed`.
   */
  #suppressCloseNotify = false;
  /**
   * Repairs 4+5 live model: the currently presented squeeze model plus the
   * focus mode it was built with. Refresh rebuilds through the same owned
   * pool/composition path as open and pushes via `updateModel` in place —
   * never a second store, never a remount.
   */
  #squeezeModel: StylusPaletteModel | null = null;
  #squeezeFocusMode: StylusPaletteFocusMode = 'full';
  #registryDisposers: Array<() => void> = [];
  /**
   *  live refs: service-resolved menu/composition instances may swap
   * without binder remount (provider replacement). `#deps` holds the
   * construction-time instances; these hold the current live instances used
   * by assembly + subscriptions. Tools/toolbarRegistry ride stable proxies
   * (hook reconciles those); menu/composition reconcile via
   * `updateLiveRegistries` below. Preserves open model/anchor (no remount).
   */
  #liveMenuRegistry: StylusMenuRegistry | null;
  #liveComposition: ToolbarCompositionRegistry | null;
  #menuDisposer: (() => void) | null = null;
  #compositionDisposer: (() => void) | null = null;

  constructor(deps: StylusAccessoryDeps) {
    this.#deps = deps;
    this.#liveMenuRegistry = deps.menuRegistry;
    this.#liveComposition = deps.toolbarComposition ?? null;
    this.#unsubscribe = deps.service.onAction((action) => this.#handle(action));
    // Live-model subscriptions: provider tool-state,
    // menu-registry, composition, and toolbar-registry changes push in place
    // via refresh — never a per-frame rebuild, never per control, never a
    // second store, never a remount. Each subscribes once per binder
    // lifetime via `#registryDisposers` (dispose/re-enable is exactly once).
    // External tool, color, width, style, history, and favorites changes
    // arrive via `tools.onDidChange` while open.
    try {
      const toolsOnChange = deps.tools.onDidChange;
      if (typeof toolsOnChange === 'function') {
        const sub = (
          deps.tools as {
            onDidChange(listener: () => void): { dispose(): void };
          }
        ).onDidChange(() => this.refreshSqueezePalette());
        this.#registryDisposers.push(() => sub.dispose());
      }
    } catch (error) {
      // Provider liveness must never break accessory dispatch; degrade +
      // report a sanitized bounded diagnostic (never stack/dumps).
      this.#report(
        `squeeze tools liveness subscribe failed: ${truncateDiagnostic(messageOf(error))}`,
      );
    }
    try {
      const menuOnChange = (
        this.#liveMenuRegistry as unknown as {
          onDidChange?: (listener: () => void) => { dispose(): void };
        }
      )?.onDidChange;
      if (typeof menuOnChange === 'function') {
        const sub = (
          this.#liveMenuRegistry as unknown as {
            onDidChange(listener: () => void): { dispose(): void };
          }
        ).onDidChange(() => this.refreshSqueezePalette());
        this.#menuDisposer = () => sub.dispose();
      }
    } catch (error) {
      // Registry liveness must never break accessory dispatch.
      this.#report(
        `squeeze menu liveness subscribe failed: ${truncateDiagnostic(messageOf(error))}`,
      );
    }
    try {
      const compOnChange = (
        this.#liveComposition as unknown as {
          onDidChange?: (listener: () => void) => { dispose(): void };
        }
      )?.onDidChange;
      if (typeof compOnChange === 'function') {
        const sub = (
          this.#liveComposition as unknown as {
            onDidChange(listener: () => void): { dispose(): void };
          }
        ).onDidChange(() => this.refreshSqueezePalette());
        this.#compositionDisposer = () => sub.dispose();
      }
    } catch (error) {
      // Registry liveness must never break accessory dispatch.
      this.#report(
        `squeeze composition liveness subscribe failed: ${truncateDiagnostic(messageOf(error))}`,
      );
    }
    try {
      const toolbarOnChange = deps.toolbarRegistry?.onDidChange;
      if (typeof toolbarOnChange === 'function') {
        const sub = (
          deps.toolbarRegistry as {
            onDidChange(listener: () => void): { dispose(): void };
          }
        ).onDidChange(() => this.refreshSqueezePalette());
        this.#registryDisposers.push(() => sub.dispose());
      }
    } catch (error) {
      // Registry liveness must never break accessory dispatch.
      this.#report(
        `squeeze toolbar liveness subscribe failed: ${truncateDiagnostic(messageOf(error))}`,
      );
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#eraserRequested = false;
    this.#operationGeneration += 1;
    this.#persistentGeneration += 1;
    this.#unsubscribe();
    for (const dispose of this.#registryDisposers) {
      try {
        dispose();
      } catch {
        // Teardown must never throw.
      }
    }
    this.#registryDisposers = [];
    if (this.#menuDisposer !== null) {
      try {
        this.#menuDisposer();
      } catch {
        // Teardown must never throw.
      }
      this.#menuDisposer = null;
    }
    if (this.#compositionDisposer !== null) {
      try {
        this.#compositionDisposer();
      } catch {
        // Teardown must never throw.
      }
      this.#compositionDisposer = null;
    }
    this.#pending = null;
    this.#closeSqueezePalette();
    this.#squeeze = 'idle';
  }

  /**
   * re-establish menu/composition liveness after a live source swap
   * without remounting the binder or palette. Tools/toolbarRegistry ride
   * stable proxies (the hook reconciles those); service-resolved
   * menu/composition instances swap here. Disposes the stale subscription
   * exactly once, subscribes to the new instance exactly once, preserves the
   * open model/anchor, and refreshes in place (equality gates no-ops).
   * Never throws; absent stays silent (no polling, no second store).
   */
  updateLiveRegistries(next: {
    readonly menuRegistry?: StylusMenuRegistry | null;
    readonly toolbarComposition?: ToolbarCompositionRegistry | null;
  }): void {
    if (this.#disposed) return;
    let changed = false;
    if (
      'menuRegistry' in next &&
      next.menuRegistry !== this.#liveMenuRegistry
    ) {
      if (this.#menuDisposer !== null) {
        try {
          this.#menuDisposer();
        } catch {
          // Teardown must never throw.
        }
        this.#menuDisposer = null;
      }
      this.#liveMenuRegistry = next.menuRegistry ?? null;
      try {
        const onChange = (
          this.#liveMenuRegistry as unknown as {
            onDidChange?: (listener: () => void) => { dispose(): void };
          }
        )?.onDidChange;
        if (typeof onChange === 'function') {
          const sub = (
            this.#liveMenuRegistry as unknown as {
              onDidChange(listener: () => void): { dispose(): void };
            }
          ).onDidChange(() => this.refreshSqueezePalette());
          this.#menuDisposer = () => sub.dispose();
        }
      } catch (error) {
        // Liveness must never break dispatch; degrade + sanitized diagnostic.
        this.#report(
          `squeeze menu liveness subscribe failed: ${truncateDiagnostic(messageOf(error))}`,
        );
      }
      changed = true;
    }
    if (
      'toolbarComposition' in next &&
      next.toolbarComposition !== this.#liveComposition
    ) {
      if (this.#compositionDisposer !== null) {
        try {
          this.#compositionDisposer();
        } catch {
          // Teardown must never throw.
        }
        this.#compositionDisposer = null;
      }
      this.#liveComposition = next.toolbarComposition ?? null;
      try {
        const onChange = (
          this.#liveComposition as unknown as {
            onDidChange?: (listener: () => void) => { dispose(): void };
          }
        )?.onDidChange;
        if (typeof onChange === 'function') {
          const sub = (
            this.#liveComposition as unknown as {
              onDidChange(listener: () => void): { dispose(): void };
            }
          ).onDidChange(() => this.refreshSqueezePalette());
          this.#compositionDisposer = () => sub.dispose();
        }
      } catch (error) {
        // Liveness must never break dispatch; degrade + sanitized diagnostic.
        this.#report(
          `squeeze composition liveness subscribe failed: ${truncateDiagnostic(messageOf(error))}`,
        );
      }
      changed = true;
    }
    if (changed) {
      try {
        this.refreshSqueezePalette();
      } catch {
        // Refresh is internally guarded; never break the swap path.
      }
    }
  }

  /** Close an open palette when the pane/document disappears. */
  handlePaneChanged(): void {
    if (this.#disposed) return;
    if (this.#squeezePalette === null) return;
    let pane: string | null = null;
    try {
      pane = this.#deps.focusedPane();
    } catch {
      pane = null;
    }
    if (pane !== this.#squeezePane) {
      this.#closeSqueezePalette();
      // Terminal pane change consumes any in-flight phased gesture: a
      // stale tail is tolerance, never a fresh edge.
      // Next squeeze (phased began or phaseless) opens fresh.
      if (
        this.#squeeze === 'tracking-open' ||
        this.#squeeze === 'tracking-close'
      ) {
        this.#squeeze = 'idle';
      } else if (this.#squeeze === 'palette-active') {
        this.#squeeze = 'idle';
      }
    }
  }

  /**
   * Presentation liveness probe: true while a squeeze palette handle is
   * held and not closed (a throwing `closed` getter keeps frozen refresh
   * semantics — treated as open). The legacy menu seam holds no handle so
   * it never counts as open.
   */
  #isSqueezePaletteOpen(): boolean {
    const handle = this.#squeezePalette;
    if (handle === null) return false;
    try {
      return handle.closed !== true;
    } catch {
      return true;
    }
  }

  /**
   * Outside-dismissal reconcile: the overlay closed itself —
   * outside pointer DOWN or Escape — and notified through its `onClose`
   * channel (wired in `useStylusAccessory`). Drops the stale handle so the
   * next squeeze opens fresh instead of toggling a dead handle, and
   * settles to idle unless a phased gesture is still in flight (its
   * `ended` then settles without reopening). Spurious notifies while a
   * palette is still open are ignored. Idempotent; never throws.
   */
  handlePaletteClosed(): void {
    if (this.#disposed) return;
    if (this.#suppressCloseNotify) return;
    try {
      if (this.#isSqueezePaletteOpen()) return;
      this.#squeezePalette = null;
      this.#squeezeOwned = false;
      this.#squeezeModel = null;
      if (
        this.#squeeze !== 'tracking-open' &&
        this.#squeeze !== 'tracking-close'
      ) {
        this.#squeeze = 'idle';
      }
    } catch {
      // Reconcile must never break dispatch or teardown.
    }
  }

  /** Guarded diagnostic fan-out: reporting never breaks dispatch. */
  #report(message: string): void {
    try {
      this.#deps.diagnostics?.(message);
    } catch {
      // Diagnostics must never break accessory dispatch.
    }
  }

  #handle(action: StylusAction): void {
    if (this.#disposed) return;
    switch (action.type) {
      case 'squeeze':
        this.#handleSqueeze(action);
        return;
      case 'eraser':
        if (action.active) this.#selectEraser();
        else this.#restoreTool();
        return;
      case 'doubleTap':
        this.#handleDoubleTap(action);
        return;
      case 'primaryButton':
      case 'secondaryButton':
      case 'proximity':
        return;
    }
  }

  // -- anchor resolution ---------------------------------------------------
  // Explicit precedence: native tip → last pen pointer →
  // focused surface center → viewport-safe fallback. The final
  // `menuAnchor()` (viewport center in production) is isolated LEGACY
  // last-resort geometry, not semantic inference: it positions, never
  // selects, presentation content.

  #resolveAnchor(
    native: StylusViewportAnchor | undefined,
  ): StylusAccessoryMenuAnchor {
    if (native !== undefined) return { x: native.x, y: native.y };
    try {
      const pen = this.#deps.lastPenAnchor?.() ?? null;
      if (pen !== null && Number.isFinite(pen.x) && Number.isFinite(pen.y)) {
        return { x: pen.x, y: pen.y };
      }
    } catch {
      // Fall through to the next fallback.
    }
    try {
      const center = this.#deps.surfaceCenter?.() ?? null;
      if (
        center !== null &&
        Number.isFinite(center.x) &&
        Number.isFinite(center.y)
      ) {
        return { x: center.x, y: center.y };
      }
    } catch {
      // Fall through to the viewport-safe fallback.
    }
    // LEGACY: viewport-center last resort. Explicitly
    // isolated geometry fallback; never a semantic role fallback.
    return this.#deps.menuAnchor();
  }

  // -- double tap ----------------------------------------------------------

  #handleDoubleTap(action: Extract<StylusAction, { type: 'doubleTap' }>): void {
    const pane = this.#deps.focusedPane();
    const snapshot =
      pane !== null ? this.#deps.tools.editorToolSnapshot(pane) : null;
    if (pane !== null && snapshot !== null)
      this.#preferred.noteSnapshot(pane, snapshot);
    const intent = this.#preferred.routeDoubleTap(
      action.preferredAction,
      pane,
      snapshot,
    );
    switch (intent.kind) {
      case 'noop':
        return;
      case 'diagnostic':
        this.#deps.diagnostics?.(intent.message);
        return;
      case 'switchTool':
        this.#executePersistentSwitch(intent.pane, intent.id);
        return;
      case 'openPalette':
        this.#openPaletteForIntent(intent.focusMode, action.anchor);
        return;
    }
  }

  #executePersistentSwitch(
    pane: string,
    id: string,
  ): boolean | Promise<boolean> | undefined {
    const snapshot = safeSnapshot(() =>
      this.#deps.tools.editorToolSnapshot(pane),
    );
    return this.#executePersistentSwitchFrom(pane, id, snapshot);
  }

  /**
   *  existence/active gating runs against the fresh snapshot passed in
   * (never the opening snapshot): intent may come from opening, but the
   * target must still exist fresh and must not already be active fresh.
   * Returns the raw execute result for async-refresh chaining, or
   * undefined when skipped. Settle notes the post-commit snapshot; callers
   * refresh sync + on Promise resolution.
   */
  #executePersistentSwitchFrom(
    pane: string,
    id: string,
    snapshotForCheck: DocumentToolSnapshot | null,
  ): boolean | Promise<boolean> | undefined {
    const generation = ++this.#persistentGeneration;
    const snapshot = snapshotForCheck;
    if (snapshot === null) return undefined;
    if (this.#deps.focusedPane() !== pane) return undefined;
    // Never restore a tool that no longer exists; never move another pane.
    // existence re-validated against fresh before switching.
    const ids = new Set(snapshot.controls.map((control) => control.id));
    if (!ids.has(id)) return undefined;
    // active-target gating from fresh — a commit that already landed
    // fresh suppresses the redundant switch; opening intent alone never
    // forces execution.
    if (findActiveSurfaceToolId(snapshot) === id) return undefined;
    let result: boolean | Promise<boolean>;
    try {
      result = this.#deps.tools.executeEditorTool(pane, id);
    } catch {
      return undefined;
    }
    const settle = (ok: boolean): boolean => {
      if (this.#disposed) return ok;
      if (generation !== this.#persistentGeneration) return ok;
      if (ok === true && pane !== null) {
        const next = safeSnapshot(() =>
          this.#deps.tools.editorToolSnapshot(pane),
        );
        if (next !== null) this.#preferred.noteSnapshot(pane, next);
      }
      return ok;
    };
    if (result instanceof Promise) {
      void result.then(settle, () => undefined);
      return result;
    }
    settle(result === true);
    return result;
  }

  // -- squeeze session ------------------------------------------------------

  #handlePreferredSqueeze(
    action: Extract<StylusAction, { type: 'squeeze' }>,
  ): boolean {
    const preferred = action.preferredAction;
    if (
      preferred === undefined ||
      preferred === 'showContextualPalette' ||
      preferred === 'showColorPalette' ||
      preferred === 'showInkAttributes'
    )
      return false;
    if (preferred === 'ignore' || preferred === 'unknown') return true;
    if (preferred === 'runSystemShortcut') {
      this.#report('runSystemShortcut: left to the system');
      return true;
    }
    const pane = this.#squeezePane;
    const snapshot =
      pane === null
        ? null
        : safeSnapshot(() => this.#deps.tools.editorToolSnapshot(pane));
    if (pane !== null && snapshot !== null)
      this.#preferred.noteSnapshot(pane, snapshot);
    const intent = this.#preferred.routeDoubleTap(preferred, pane, snapshot);
    if (intent.kind === 'switchTool')
      this.#executePersistentSwitch(intent.pane, intent.id);
    return true;
  }

  #handleSqueeze(action: Extract<StylusAction, { type: 'squeeze' }>): void {
    // Phaseless squeezes are atomic preferred actions with an explicit
    // path — never `phase ?? 'began'`, never tracking-stuck.
    if (action.phase === undefined) {
      this.#handleCompleteSqueeze(action);
      return;
    }
    switch (action.phase) {
      case 'began':
        this.#squeezeBegan(action);
        return;
      case 'changed':
        // Keep the circle centered at the initial squeeze position.
        // Continued pressure and hover motion never drag an open palette.
        return;
      case 'ended':
        this.#squeezeEnded();
        return;
      case 'cancelled':
        this.#squeezeCancelled();
        return;
    }
  }

  /**
   * A phaseless squeeze performs its preferred action once. Palette actions
   * toggle an open palette and settle without entering tracking. Any in-flight
   * phased gesture is consumed so its stale tail cannot repeat the action.
   */
  #handleCompleteSqueeze(
    action: Extract<StylusAction, { type: 'squeeze' }>,
  ): void {
    const anchor = this.#resolveAnchor(action.anchor);
    try {
      this.#squeezePane = this.#deps.focusedPane();
    } catch {
      this.#squeezePane = null;
    }
    if (this.#handlePreferredSqueeze(action)) {
      this.#squeeze = this.#isSqueezePaletteOpen() ? 'palette-active' : 'idle';
      return;
    }
    if (this.#isSqueezePaletteOpen()) {
      this.#closeSqueezePalette();
      this.#squeeze = 'idle';
      return;
    }
    this.#openSqueezePalette(focusModeFor(action.preferredAction), anchor);
    this.#squeeze = this.#isSqueezePaletteOpen() ? 'palette-active' : 'idle';
  }

  #squeezeBegan(action: Extract<StylusAction, { type: 'squeeze' }>): void {
    // Duplicate `began` inside one physical gesture (platform re-send):
    // absorb — the gesture already spent its preferred action at its first
    // `began`; later motion arrives via `changed`.
    if (
      this.#squeeze === 'tracking-open' ||
      this.#squeeze === 'tracking-close'
    ) {
      return;
    }
    const anchor = this.#resolveAnchor(action.anchor);
    // Began probes never throw outward (the service also guards, but the
    // binder stays fail-soft on its own). A throwing focusedPane degrades to
    // null here; `#buildSqueezeModel` reports the probe failure with a
    // diagnostic on open/refresh.
    try {
      this.#squeezePane = this.#deps.focusedPane();
    } catch {
      this.#squeezePane = null;
    }
    if (this.#handlePreferredSqueeze(action)) {
      this.#squeeze = 'tracking-close';
      return;
    }
    if (this.#isSqueezePaletteOpen()) {
      // TOGGLE-CLOSE: the palette is open, so this `began` closes it
      // exactly once. The gesture records `tracking-close` so its
      // `changed` tail cannot move a dead handle and its `ended` tail
      // cannot reopen — never close+reopen on squeeze-while-open.
      this.#squeeze = 'tracking-close';
      this.#closeSqueezePalette();
      return;
    }
    this.#squeeze = 'tracking-open';
    this.#openSqueezePalette(focusModeFor(action.preferredAction), anchor);
  }

  #squeezeEnded(): void {
    // `ended` only settles — never toggles, never executes. A lone
    // `ended` with no gesture in flight is tolerance (normalize settled
    // state, no toggle). A stale tail after settle stays settled.
    if (this.#squeeze === 'tracking-open') {
      this.#squeezeOwned = false;
      this.#squeeze = this.#isSqueezePaletteOpen() ? 'palette-active' : 'idle';
      return;
    }
    if (this.#squeeze === 'tracking-close') {
      // Close gesture stays closed (its `began` already closed exactly
      // once — never reopen on the tail).
      this.#squeeze = 'idle';
      return;
    }
    this.#squeeze = this.#isSqueezePaletteOpen() ? 'palette-active' : 'idle';
  }

  #squeezeCancelled(): void {
    // Cancel closes a palette created by that squeeze and performs no tool
    // action. A settled palette (ownership released at `ended`) is
    // dismissed by outside interaction, not by a stale gesture. Lone
    // `cancelled` with no gesture in flight is tolerance (no state change
    // beyond normalizing a settled open palette).
    if (this.#squeeze === 'tracking-open') {
      if (this.#squeezeOwned) this.#closeSqueezePalette();
      this.#squeezeOwned = false;
      this.#squeeze = 'idle';
      return;
    }
    if (this.#squeeze === 'tracking-close') {
      this.#squeeze = 'idle';
      return;
    }
    // Lone cancelled: leave a settled open palette alone.
  }

  #openSqueezePalette(
    focusMode: StylusPaletteFocusMode,
    anchor: StylusAccessoryMenuAnchor,
  ): void {
    const built = this.#buildSqueezeModel(focusMode);
    if (built === null) {
      // Non-surface editors: fall back to registry entries only so squeeze
      // never opens an empty core palette where no tools exist.
      // Probe failures degrade and report; an absent optional stays silent.
      const report = (message: string): void => {
        try {
          this.#deps.diagnostics?.(message);
        } catch {
          // Diagnostics must never break accessory dispatch.
        }
      };
      const context = safeContext(
        () => this.#deps.menuContext(),
        (error) =>
          report(`squeeze menu context probe failed: ${messageOf(error)}`),
      );
      const contributions =
        context !== null
          ? safeEntries(
              () => this.#liveMenuRegistry?.entries(context) ?? [],
              (error) =>
                report(
                  `squeeze menu registry entries failed: ${messageOf(error)}`,
                ),
            )
          : [];
      if (contributions.length > 0) this.#deps.showMenu(contributions, anchor);
      return;
    }
    const { model } = built;
    if (this.#deps.showPalette !== undefined) {
      this.#closeSqueezePalette();
      // a throwing presentation host never breaks gesture dispatch —
      // degrade + report; the gesture settles at `ended` without a palette.
      try {
        this.#squeezePalette = this.#deps.showPalette(model, anchor);
      } catch (error) {
        this.#report(
          `squeeze palette presentation failed: ${messageOf(error)}`,
        );
        return;
      }
      this.#squeezeOwned = true;
      this.#squeezeModel = model;
      this.#squeezeFocusMode = focusMode;
      return;
    }
    // LEGACY: no dedicated palette host (tests/doubles).
    // Render core tools through the legacy menu seam so behavior stays
    // observable. Production hosts provide `showPalette` (React owns the
    // DOM); the menu seam never selects semantic roles, only presentation.
    const entries: MenuEntry[] = [
      ...model.tools.map((tool) => ({ label: tool.label })),
      ...model.contributions,
    ];
    this.#deps.showMenu(entries, anchor);
    // Legacy menu seam has no live handle: keep the model for refresh
    // no-op semantics (refresh without a handle stays inert).
    this.#squeezeModel = model;
    this.#squeezeFocusMode = focusMode;
  }

  /**
   * Repairs 4+5 live model: rebuild the squeeze palette from the current
   * provider/composition/registry state and push it in place via
   * `updateModel` — never a second store, never a remount.
   *
   * - No palette open (or legacy menu seam): no-op.
   * - Rebuild resolves null (non-surface, empty pool): close instead of
   *   leaving a stale palette open (lifecycle B terminal-close).
   * - Rebuild equals the presented model: no-op (no push, no remount).
   * - Otherwise: `updateModel` in place when the handle offers it (legacy
   *   doubles without the channel are a guarded no-op push); anchor
   *   position is preserved because the handle identity never changes.
   *
   * Lifecycle A (update-in-place) covers tool/color/width/style/undo/redo/
   * favorite/eraser/plugin changes; lifecycle B (terminal-close) covers
   * only the stale-no-longer-resolves case. Intentionally terminal palette
   * actions execute+close via the stale path when their commit removes the
   * model; all other selections update in place.
   */
  refreshSqueezePalette(): void {
    if (this.#disposed) return;
    const handle = this.#squeezePalette;
    if (handle === null) return;
    try {
      if (handle.closed === true) {
        this.#squeezePalette = null;
        this.#squeezeModel = null;
        if (this.#squeeze === 'palette-active') this.#squeeze = 'idle';
        return;
      }
    } catch {
      // A throwing `closed` getter must never break dispatch; treat as open.
    }
    const focusMode = this.#squeezeFocusMode;
    const built = this.#buildSqueezeModel(focusMode);
    if (built === null) {
      this.#closeSqueezePalette();
      if (this.#squeeze === 'palette-active') this.#squeeze = 'idle';
      return;
    }
    const next = built.model;
    const current = this.#squeezeModel;
    if (current !== null && squeezeModelsEqual(current, next)) return;
    // only mark presented when the channel exists and did not throw;
    // otherwise retain current so a later refresh can retry (legacy inert
    // doubles stay retryable instead of falsely marked presented).
    if (typeof handle.updateModel !== 'function') return;
    try {
      handle.updateModel(next);
    } catch {
      // Palette teardown must never break accessory dispatch; retain current
      // for retry.
      return;
    }
    this.#squeezeModel = next;
  }

  /**
   * Shared squeeze model builder (open + refresh): the same owned pool
   * (provider + shell + trusted/community) and squeeze projection as the
   * normal toolbar — never from `snapshot.controls` alone. Returns null
   * when no surface tools resolve so callers close/fall back instead of
   * presenting stale content. Records history like open does.
   */
  #buildSqueezeModel(
    focusMode: StylusPaletteFocusMode,
  ): { model: StylusPaletteModel } | null {
    const report = (message: string): void => {
      try {
        this.#deps.diagnostics?.(message);
      } catch {
        // Diagnostics must never break accessory dispatch.
      }
    };
    const pane =
      this.#squeezePane ??
      safePane(
        () => this.#deps.focusedPane(),
        (error) =>
          report(`squeeze focused pane probe failed: ${messageOf(error)}`),
      );
    const snapshot =
      pane !== null
        ? safeSnapshot(
            () => this.#deps.tools.editorToolSnapshot(pane),
            (error) =>
              report(`squeeze tool snapshot probe failed: ${messageOf(error)}`),
          )
        : null;
    try {
      if (pane !== null && snapshot !== null)
        this.#preferred.noteSnapshot(pane, snapshot);
    } catch {
      // Internal history tracking must never break assembly.
    }
    const context = safeContext(
      () => this.#deps.menuContext(),
      (error) =>
        report(`squeeze menu context probe failed: ${messageOf(error)}`),
    );
    const contributions =
      context !== null
        ? safeEntries(
            () => this.#liveMenuRegistry?.entries(context) ?? [],
            (error) =>
              report(
                `squeeze menu registry entries failed: ${messageOf(error)}`,
              ),
          )
        : [];
    const canUndo =
      pane !== null
        ? safeFlag(
            () =>
              this.#deps.commands?.canExecEditorCommand('undo', pane) ?? false,
            (error) =>
              report(`squeeze history probe failed: ${messageOf(error)}`),
          )
        : false;
    const canRedo =
      pane !== null
        ? safeFlag(
            () =>
              this.#deps.commands?.canExecEditorCommand('redo', pane) ?? false,
            (error) =>
              report(`squeeze history probe failed: ${messageOf(error)}`),
          )
        : false;
    // One owned pool (provider + shell + trusted/community) shared with the
    // normal toolbar. The squeeze projection resolves against the same
    // assembled pool — never from `snapshot.controls` alone, which would
    // exclude plugin-owned controls.
    const toolbarContext = stylusToolbarContextFor(pane, context, snapshot);
    let toolbarEntries: readonly {
      readonly contributionId: string;
      readonly controls: readonly DocumentToolControl[];
    }[] = [];
    if (toolbarContext !== null && this.#deps.toolbarRegistry != null) {
      try {
        toolbarEntries = this.#deps.toolbarRegistry.entries(toolbarContext);
      } catch (error) {
        // Available-service throws degrade and report; an optional
        // absent (guard above) stays silent.
        report(`squeeze toolbar registry entries failed: ${messageOf(error)}`);
        toolbarEntries = [];
      }
    }
    let shellOwned: ReturnType<typeof shellHistoryOwnedControls>;
    try {
      shellOwned = shellHistoryOwnedControls({ canUndo, canRedo });
    } catch (error) {
      report(`squeeze shell history failed: ${messageOf(error)}`);
      shellOwned = [];
    }
    let assembled: ReturnType<typeof assembleOwnedPool>;
    try {
      assembled = assembleOwnedPool({
        providerControls: snapshot?.controls ?? [],
        shellControls: shellOwned.map((owned) => owned.control),
        contributions: toolbarEntries,
      });
    } catch (error) {
      report(`squeeze owned pool assembly failed: ${messageOf(error)}`);
      return null;
    }
    const ownedPool = assembled.ownedPool;
    let composition: ReturnType<typeof resolveToolbarComposition> | undefined;
    if (context?.kindId != null && this.#liveComposition != null) {
      let compSnapshot:
        | Parameters<typeof resolveToolbarComposition>[0]['snapshot']
        | null = null;
      try {
        compSnapshot = this.#liveComposition.snapshot();
      } catch (error) {
        report(`squeeze composition snapshot failed: ${messageOf(error)}`);
        compSnapshot = null;
      }
      if (compSnapshot !== null) {
        try {
          composition = resolveToolbarComposition({
            snapshot: compSnapshot,
            kindId: context.kindId,
            controls: ownedPool.map((owned) => owned.control),
            projection: 'squeeze',
          });
        } catch (error) {
          report(`squeeze composition resolve failed: ${messageOf(error)}`);
          composition = undefined;
        }
      }
    }
    // squeeze assembled diagnostics must reach `deps.diagnostics`
    // instead of silent drops. Reuse the existing diagnostic channel (no new
    // authority): duplicate owned-pool claims, composition diagnostics
    // (duplicate roles, ordering cycles), and unresolved squeeze items.
    // Each fan-out call is guarded — a throwing diagnostics channel
    // must never break open/refresh (began+refresh never throw).
    for (const diagnostic of assembled.diagnostics) {
      report(diagnostic);
    }
    if (composition !== undefined) {
      for (const diagnostic of composition.diagnostics) {
        report(diagnostic);
      }
      for (const id of composition.unresolved) {
        report(`unresolved toolbar item '${id}'`);
      }
    }
    let model: StylusPaletteModel | null;
    try {
      model = buildStylusPaletteModel(snapshot, {
        canUndo,
        canRedo,
        focusMode,
        contributions,
        ...(this.#deps.slots === undefined ? {} : { slots: this.#deps.slots }),
        ...(composition !== undefined ? { composition } : {}),
        ownedPool,
      });
    } catch (error) {
      report(`squeeze model build failed: ${messageOf(error)}`);
      return null;
    }
    if (model === null) return null;
    return { model };
  }

  #openPaletteForIntent(
    focusMode: StylusPaletteFocusMode,
    nativeAnchor?: StylusViewportAnchor,
  ): void {
    const anchor = this.#resolveAnchor(nativeAnchor);
    try {
      this.#squeezePane = this.#deps.focusedPane();
    } catch {
      this.#squeezePane = null;
    }
    // A double-tap takeover is not a squeeze gesture: any in-flight phased
    // tracking is dropped so its stale tail settles through the lone path
    // (never a second toggle) instead of masquerading as tracked.
    this.#openSqueezePalette(focusMode, anchor);
    this.#squeeze = this.#isSqueezePaletteOpen() ? 'palette-active' : 'idle';
    // Double-tap palettes are not squeeze-owned: outside dismissal owns them.
    this.#squeezeOwned = false;
  }

  #closeSqueezePalette(): void {
    // Suppressed re-entrancy: the overlay's synchronous `onClose` echo must
    // not reconcile mid-replace (see `handlePaletteClosed`); this path does
    // its own bookkeeping below.
    this.#suppressCloseNotify = true;
    try {
      this.#squeezePalette?.close();
    } catch {
      // Palette teardown must never break accessory dispatch.
    } finally {
      this.#suppressCloseNotify = false;
    }
    this.#squeezePalette = null;
    this.#squeezeOwned = false;
    this.#squeezeModel = null;
  }

  // -- momentary physical eraser (independent state machine) ----------------

  #selectEraser(): void {
    this.#eraserRequested = true;
    const generation = ++this.#operationGeneration;
    const pane = this.#deps.focusedPane();
    if (pane === null) return;
    const snapshot = this.#deps.tools.editorToolSnapshot(pane);
    if (snapshot === null) return;
    const eraserId = findSurfaceEraserControlId(snapshot);
    if (eraserId === null) return;
    const activeId = findActiveSurfaceToolId(snapshot);
    if (activeId === eraserId) return;
    const previous: EraserSelection = {
      pane,
      previousControlId: activeId,
      requestId: generation,
    };
    // Async correctness: only record restorable state after the eraser
    // executes successfully. A `false`/rejection leaves the current tool
    // unchanged and clears restore state.
    const result = this.#deps.tools.executeEditorTool(pane, eraserId);
    if (result instanceof Promise) {
      result.then(
        (ok) => {
          if (this.#disposed) return;
          if (generation !== this.#operationGeneration) {
            // Superseded (release, newer selection, or dispose arrived
            // first). If the late success actually landed the editor on the
            // eraser after release, repair immediately: the rubber is up
            // but the editor would otherwise be stuck on the eraser.
            if (ok === true && this.#eraserRequested === false) {
              this.#repairLateEraserLand(previous, eraserId);
            }
            return;
          }
          this.#pending = ok === true ? previous : null;
        },
        () => {
          if (this.#disposed) return;
          if (generation !== this.#operationGeneration) return;
          this.#pending = null;
        },
      );
      return;
    }
    if (generation !== this.#operationGeneration) return;
    this.#pending = result === true ? previous : null;
  }

  /**
   * Fire-and-forget tool switch with rejection containment: restore paths
   * must never surface an unhandled rejection after dispose or failure.
   */
  #executeForget(pane: string, controlId: string): void {
    try {
      const result = this.#deps.tools.executeEditorTool(pane, controlId);
      if (result instanceof Promise) {
        result.then(undefined, () => undefined);
      }
    } catch {
      // Tool routing already reports failure via false/rejection.
    }
  }

  /**
   * Late async success landed the editor on the eraser after the rubber
   * was already released: switch straight back to the captured previous
   * tool when it is still valid. Fire-and-forget repair; failure leaves
   * the current tool alone.
   */
  #repairLateEraserLand(selection: EraserSelection, eraserId: string): void {
    if (selection.previousControlId === null) return;
    const pane = this.#deps.focusedPane();
    if (pane === null || pane !== selection.pane) return;
    const snapshot = this.#deps.tools.editorToolSnapshot(pane);
    if (snapshot === null) return;
    if (findActiveSurfaceToolId(snapshot) !== eraserId) return;
    if (findSurfaceEraserControlId(snapshot) === null) return;
    const ids = new Set(snapshot.controls.map((control) => control.id));
    if (!ids.has(selection.previousControlId)) return;
    this.#executeForget(pane, selection.previousControlId);
  }

  #restoreTool(): void {
    // Release immediately invalidates pending activation: a late success
    // afterwards repairs (or drops) via the superseded path above.
    this.#eraserRequested = false;
    ++this.#operationGeneration;
    const previous = this.#pending;
    this.#pending = null;
    if (previous === null || previous.previousControlId === null) return;
    const pane = this.#deps.focusedPane();
    // Focus moved on while the eraser was held: never yank another
    // pane's tools.
    if (pane === null || pane !== previous.pane) return;
    const snapshot = this.#deps.tools.editorToolSnapshot(pane);
    if (snapshot === null) return;
    const eraserId = findSurfaceEraserControlId(snapshot);
    // The focused editor changed (or lost its eraser): there is no safe
    // restore target, so leave the current tool alone.
    if (eraserId === null) return;
    // The user switched tools by hand mid-gesture: respect the choice.
    if (findActiveSurfaceToolId(snapshot) !== eraserId) return;
    this.#executeForget(pane, previous.previousControlId);
  }
}
