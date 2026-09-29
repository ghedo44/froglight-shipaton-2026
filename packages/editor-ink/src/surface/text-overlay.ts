/**
 * Transient text-overlay lifecycle (hardening).
 *
 * React owns the visible container: the provider commits an
 * `overlayRoot` inside the isolated React root and the engine only mounts
 * the ephemeral editor and resize handle inside it. The editor is keystroke-ephemeral —
 * no per-keystroke model mutation, dirty marking, or re-render — and the
 * canonical commit flows through the existing surface mutation path as ONE
 * history gesture (one undo step).
 *
 * Entry: tap / double-click / Enter opens edit with caret + OSK.
 * - single-line (no valid `wrapWidth`): `<input>`, Enter commits.
 * - multiline (valid `wrapWidth` present): `<textarea>`, Enter inserts a
 *   newline, Ctrl/Cmd+Enter commits.
 * - Esc commits pending text (never discards); click-away / blur /
 *   tool-switch / flush / destroy commits without loss. Only a truly
 *   empty commit closes without a model update (no undo entry).
 *
 * IME: `isComposing` guards Enter so in-flight composition never
 * commits early; a settled flag makes the commit exactly-once across
 * keydown / compositionend / blur convergence. Copy/paste is never
 * intercepted — committed text preserves chars and breaks verbatim
 * (CRLF/CR normalized to LF deterministically, no trimming), including
 * mid-string multiline pastes.
 *
 * Geometry: the editor mirrors the Surface text canvas metrics
 * (effective size, 1.25 line height, wrapWidth box, align, role weight).
 * Its resize handle previews a new wrapWidth and commits with the text in
 * one history gesture. Forward-compatible readers below
 * mirror the effective-value rules defensively over unknown fields
 * (this module never writes canonical bytes and never imports model
 * internals — when merges, the same records drive both paths).
 *
 * Keyboard: host-owned insets only. The overlay reads
 * `--fl-keyboard-inset-height` / `--fl-keyboard-overlay-bottom` to clamp
 * its own max-height and never resizes the WebView.
 */

import type { Camera, Point } from '@froglight/foundation';

/** Surface ceiling mirrored from the canonical coordinate cap (read-only). */
const SURFACE_MAX_COORDINATE = 1e9;
/** Default font size when `size` is absent/invalid (mirrors).*/
const TEXT_DEFAULT_SIZE = 16;
/** Nominal per-line height factor (mirrors contracts §1.2).*/
const TEXT_LINE_HEIGHT_FACTOR = 1.25;

export interface TextOverlayCreateRequest {
  readonly kind: 'create';
  readonly surfacePoint: Point;
  readonly camera: Camera;
  readonly initialText?: string;
  /** Live pen color for the editor preview (never canonical). */
  readonly penColor?: string;
  /**
   * Live pen stroke width in px (preview hint only). Ignored for editor
   * font sizing: create previews at TEXT_DEFAULT_SIZE, since
   * create commits store no size and the canvas renders at the default.
   */
  readonly penSize?: number;
  readonly size?: unknown;
  readonly color?: string;
  readonly appearance?: unknown;
  readonly role?: unknown;
  /** Maximum text-box width in surface units for a bounded page. */
  readonly maxWrapWidth?: number;
  readonly maxHeight?: number;
  readonly resizable?: boolean;
  readonly selectAll?: boolean;
}

export interface TextOverlayEditRequest {
  readonly kind: 'edit';
  readonly objectId: string;
  readonly surfacePoint: Point;
  readonly camera: Camera;
  readonly text: string;
  readonly size?: unknown;
  readonly color?: string;
  readonly appearance?: unknown;
  readonly role?: unknown;
  readonly maxWrapWidth?: number;
  readonly maxHeight?: number;
  readonly resizable?: boolean;
  readonly selectAll?: boolean;
}

export type TextOverlayOpenRequest =
  | TextOverlayCreateRequest
  | TextOverlayEditRequest;

export interface TextOverlayOptions {
  /** React-owned overlay container committed by the provider skeleton. */
  readonly overlayRoot: HTMLElement;
  /** Focus return target for keyboard commits (surface root). */
  readonly focusReturn?: HTMLElement | null;
  /** Formatting chrome may take focus without committing the draft. */
  readonly keepOpenForTarget?: (target: EventTarget | null) => boolean;
  readonly onOpenChange?: () => void;
  readonly onCommitCreate: (
    surfacePoint: Point,
    text: string,
    wrapWidth?: number,
  ) => void;
  readonly onCommitEdit: (
    objectId: string,
    text: string,
    wrapWidth?: number,
  ) => void;
}

export interface TextOverlayHandle {
  openRequest(request: TextOverlayOpenRequest): void;
  openEdit(request: Omit<TextOverlayEditRequest, 'kind'>): void;
  close(commitPending: boolean): void;
  isOpen(): boolean;
  /** 'create' | 'edit' while open, else null (tests/diagnostics). */
  currentMode(): 'create' | 'edit' | null;
  /** Id of the record under edit, else null. */
  editingId(): string | null;
  updateAppearance(
    appearance: Pick<
      TextOverlayCreateRequest,
      'size' | 'color' | 'role' | 'appearance'
    >,
  ): void;
  dispose(): void;
}

/** CRLF/CR → LF deterministically; no trimming (paste preservation). */
export function normalizeOverlayText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** True when `wrapWidth` is usable for layout (mirrors rule).*/
export function isUsableWrapWidth(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= SURFACE_MAX_COORDINATE
  );
}

/** Effective wrap width from an `appearance`-like value; null = unbounded. */
export function overlayWrapWidthOf(appearance: unknown): number | null {
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
  ) {
    const wrapWidth = (appearance as Record<string, unknown>).wrapWidth;
    if (isUsableWrapWidth(wrapWidth)) return wrapWidth;
  }
  return null;
}

/** Effective font size (mirrors): finite > 0 within cap, else 16.*/
export function overlayEffectiveSizeOf(size: unknown): number {
  if (
    typeof size === 'number' &&
    Number.isFinite(size) &&
    size > 0 &&
    size <= SURFACE_MAX_COORDINATE
  ) {
    return size;
  }
  return TEXT_DEFAULT_SIZE;
}

/**
 * Effective surface-text size: `appearance.size` when valid,
 * else `size` via `overlayEffectiveSizeOf`. Matches the canonical
 * `effectiveSurfaceTextSizeOf` so the overlay previews the same H1/H2 size
 * the selection reports and the canvas renders. Read-only.
 */
export function overlayEffectiveSizeWithAppearance(
  size: unknown,
  appearance: unknown,
): number {
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
  ) {
    const appearanceSize = (appearance as Record<string, unknown>).size;
    if (
      typeof appearanceSize === 'number' &&
      Number.isFinite(appearanceSize) &&
      appearanceSize > 0 &&
      appearanceSize <= SURFACE_MAX_COORDINATE
    ) {
      return appearanceSize;
    }
  }
  return overlayEffectiveSizeOf(size);
}

/**
 * Additive bold trait: exactly `true` in `appearance` reads
 * active. Never throws.
 */
export function overlayBoldOf(appearance: unknown): boolean {
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
  ) {
    return (appearance as Record<string, unknown>).bold === true;
  }
  return false;
}

/**
 * Additive italic trait: exactly `true` in `appearance`
 * reads active. Never throws.
 */
export function overlayItalicOf(appearance: unknown): boolean {
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
  ) {
    return (appearance as Record<string, unknown>).italic === true;
  }
  return false;
}

function overlayAlignOf(appearance: unknown): 'start' | 'center' | 'end' {
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
  ) {
    const align = (appearance as Record<string, unknown>).align;
    if (align === 'center' || align === 'end' || align === 'start')
      return align;
  }
  return 'start';
}

function overlayIsHeading(role: unknown): boolean {
  return role === 'heading';
}

/**
 * Host-owned keyboard inset in CSS px (read-only). Never
 * resizes the WebView; the overlay clamps its own max-height against it.
 */
export function readKeyboardInsetPx(): number {
  try {
    if (typeof document === 'undefined') return 0;
    const styles = getComputedStyle(document.documentElement);
    for (const name of [
      '--fl-keyboard-overlay-bottom',
      '--fl-keyboard-inset-height',
    ]) {
      const raw = styles.getPropertyValue(name).trim();
      if (raw === '') continue;
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // Inset lookup never breaks editing.
  }
  return 0;
}

/** Create the transient inline text editor owned by the surface engine. */
export function createTextOverlay(
  options: TextOverlayOptions,
): TextOverlayHandle {
  const { overlayRoot: container, onCommitCreate, onCommitEdit } = options;
  const focusReturn = options.focusReturn ?? null;

  let editor: HTMLInputElement | HTMLTextAreaElement | null = null;
  let mode: 'create' | 'edit' | null = null;
  let createPoint: Point | null = null;
  let editId: string | null = null;
  let settled = false;
  let composing = false;
  let disposed = false;
  let removeListeners: (() => void) | null = null;
  let resizeHandle: HTMLButtonElement | null = null;
  let editedWidth: number | undefined;
  let updateAppearance: TextOverlayHandle['updateAppearance'] | null = null;

  function finish(removeNode: boolean): void {
    const wasOpen = editor !== null;
    removeListeners?.();
    removeListeners = null;
    if (removeNode) editor?.remove();
    resizeHandle?.remove();
    resizeHandle = null;
    editor = null;
    mode = null;
    createPoint = null;
    editId = null;
    settled = false;
    composing = false;
    editedWidth = undefined;
    updateAppearance = null;
    if (wasOpen) options.onOpenChange?.();
  }

  function commitOnce(): void {
    if (settled || editor === null || mode === null) return;
    settled = true;
    const raw = editor.value;
    const text = normalizeOverlayText(raw);
    const currentMode = mode;
    const currentPoint = createPoint;
    const currentId = editId;
    const currentWidth = editedWidth;
    const returnFocus = focusReturn;
    finish(true);
    // Empty commits close without a model update (no undo entry).
    // Whitespace-only is treated as empty (no invisible objects), but any
    // other text commits verbatim — leading/trailing spaces and breaks
    // survive (paste preservation; no trimming).
    if (currentMode === 'create' && (text === '' || text.trim() === '')) return;
    if (currentMode === 'create' && currentPoint !== null) {
      onCommitCreate(currentPoint, text, currentWidth);
    } else if (currentMode === 'edit' && currentId !== null) {
      onCommitEdit(currentId, text, currentWidth);
    }
    // Keyboard commits return focus to the surface root so shortcuts keep
    // working; blur-driven commits leave focus where the user put it.
    try {
      if (
        returnFocus !== null &&
        document.activeElement !== returnFocus &&
        document.body.contains(returnFocus)
      ) {
        // Only reclaim when focus is orphaned (Enter/Esc path leaves it
        // on body after node removal); never yank a click-away target.
        if (
          document.activeElement === document.body ||
          document.activeElement === null
        ) {
          returnFocus.focus({ preventScroll: true });
        }
      }
    } catch {
      // Focus return never breaks commit.
    }
  }

  function discard(): void {
    finish(true);
  }

  function close(commitPending: boolean): void {
    if (editor === null) return;
    if (commitPending) {
      commitOnce();
      return;
    }
    discard();
  }

  function clampHeight(
    node: HTMLInputElement | HTMLTextAreaElement,
    viewY: number,
  ): void {
    try {
      const inset = readKeyboardInsetPx();
      const hostHeight =
        container.clientHeight ||
        (typeof window !== 'undefined' ? window.innerHeight : 0);
      const available = hostHeight - viewY - 8 - inset;
      const max = Math.min(
        Math.max(48, Math.floor(available)),
        Number(node.dataset.maxHeight ?? Infinity),
      );
      node.style.maxHeight = `${max}px`;
      node.dataset.keyboardClamped = inset > 0 ? 'true' : 'false';
      if (node instanceof HTMLTextAreaElement) {
        node.style.height = 'auto';
        const grown = Math.min(node.scrollHeight, max);
        if (Number.isFinite(grown) && grown > 0) {
          node.style.height = `${grown}px`;
        }
      }
    } catch {
      // Clamping never breaks editing.
    }
  }

  function openRequest(request: TextOverlayOpenRequest): void {
    if (disposed) return;
    // Click-away / rapid re-entry commits without loss: never
    // discard pending text when a new overlay opens.
    if (editor !== null) commitOnce();

    const camera = request.camera;
    const view = {
      x: (request.surfacePoint.x - camera.x) * camera.zoom,
      y: (request.surfacePoint.y - camera.y) * camera.zoom,
    };
    const zoom =
      Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
    const initialText =
      request.kind === 'edit'
        ? normalizeOverlayText(request.text)
        : normalizeOverlayText(request.initialText ?? '');
    const wrapWidth = overlayWrapWidthOf(request.appearance);
    // Create and edit previews use the exact appearance that will render
    // after commit. `penSize` remains a stroke-width compatibility hint.
    let effectiveSize = overlayEffectiveSizeWithAppearance(
      request.size,
      request.appearance,
    );
    const align = overlayAlignOf(request.appearance);
    const heading = overlayIsHeading(request.role);
    const bold = overlayBoldOf(request.appearance);
    const italic = overlayItalicOf(request.appearance);
    const color =
      request.kind === 'edit'
        ? request.color
        : (request.color ?? request.penColor ?? undefined);
    const multiline = wrapWidth !== null;
    const maxWidthUnits =
      typeof request.maxWrapWidth === 'number' &&
      Number.isFinite(request.maxWrapWidth) &&
      request.maxWrapWidth > 0
        ? request.maxWrapWidth
        : undefined;
    const maxWidthPx =
      maxWidthUnits === undefined ? undefined : maxWidthUnits * zoom;

    // Engine-owned temporary editing control:
    // created per text placement inside the React-owned container,
    // removed on commit/discard. Never stable presentation.
    const node: HTMLInputElement | HTMLTextAreaElement = multiline
      ? document.createElement('textarea')
      : document.createElement('input');
    node.className =
      'fl-ink-text-input' + (multiline ? ' fl-ink-text-area' : '');
    node.setAttribute(
      'aria-label',
      request.kind === 'edit' ? 'Edit text' : 'New text',
    );
    node.setAttribute('data-fl-text-overlay', request.kind);
    try {
      (node as HTMLElement & { inputMode?: string }).inputMode = 'text';
      node.setAttribute('autocapitalize', 'sentences');
      node.setAttribute('autocomplete', 'off');
      node.setAttribute('spellcheck', 'true');
      node.setAttribute('enterkeyhint', multiline ? 'enter' : 'done');
    } catch {
      // Hint attributes never break editing.
    }
    node.style.left = `${view.x}px`;
    node.style.top = `${view.y}px`;
    node.style.fontSize = `${effectiveSize * zoom}px`;
    node.style.lineHeight = String(TEXT_LINE_HEIGHT_FACTOR);
    node.style.textAlign =
      align === 'center' ? 'center' : align === 'end' ? 'right' : 'left';
    node.style.fontWeight = heading || bold ? '700' : '400';
    node.style.fontStyle = italic ? 'italic' : 'normal';
    if (color !== undefined) node.style.color = color;
    if (multiline && wrapWidth !== null) {
      node.style.width = `${wrapWidth * zoom}px`;
      node.style.minWidth = '24px';
      node.style.whiteSpace = 'pre-wrap';
      node.style.overflowWrap = 'break-word';
      (node as HTMLTextAreaElement).wrap = 'soft';
      (node as HTMLTextAreaElement).rows = 1;
    } else {
      node.style.minWidth = '120px';
    }
    if (maxWidthPx !== undefined) node.style.maxWidth = `${maxWidthPx}px`;
    if (request.kind === 'create') {
      node.setAttribute('placeholder', 'Type… Enter to place');
    }
    if (request.maxHeight !== undefined)
      node.dataset.maxHeight = String(request.maxHeight * zoom);
    node.value = initialText;
    container.appendChild(node);
    editor = node;
    editedWidth =
      request.kind === 'create' ? (wrapWidth ?? undefined) : undefined;
    mode = request.kind;
    createPoint =
      request.kind === 'create' ? { ...request.surfacePoint } : null;
    editId = request.kind === 'edit' ? request.objectId : null;
    settled = false;
    composing = false;

    clampHeight(node, view.y);

    // The visible handle belongs to the transient editor. Width is previewed
    // in CSS pixels, then stored in surface units as appearance.wrapWidth.
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'fl-ink-text-resize-handle';
    handle.setAttribute('aria-label', 'Resize text box');
    const positionHandle = (): void => {
      handle.style.left = `${view.x + node.getBoundingClientRect().width - 5}px`;
      handle.style.top = `${view.y + Math.max(node.getBoundingClientRect().height, effectiveSize * zoom * 1.25) - 5}px`;
    };
    if (request.resizable === false) handle.hidden = true;
    container.appendChild(handle);
    resizeHandle = handle;
    positionHandle();
    updateAppearance = (appearance): void => {
      effectiveSize = overlayEffectiveSizeWithAppearance(
        appearance.size,
        appearance.appearance,
      );
      node.style.fontSize = `${effectiveSize * zoom}px`;
      node.style.fontWeight =
        overlayIsHeading(appearance.role) ||
        overlayBoldOf(appearance.appearance)
          ? '700'
          : '400';
      node.style.fontStyle = overlayItalicOf(appearance.appearance)
        ? 'italic'
        : 'normal';
      node.style.textAlign = overlayAlignOf(appearance.appearance);
      if (appearance.color !== undefined) node.style.color = appearance.color;
      clampHeight(node, view.y);
      positionHandle();
    };
    options.onOpenChange?.();
    const onResizeDown = (event: PointerEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = node.getBoundingClientRect().width;
      handle.setPointerCapture?.(event.pointerId);
      const onMove = (move: PointerEvent): void => {
        const width = Math.min(
          maxWidthPx ?? Number.POSITIVE_INFINITY,
          Math.max(
            Math.min(48, maxWidthPx ?? 48),
            startWidth + move.clientX - startX,
          ),
        );
        node.style.width = `${width}px`;
        editedWidth = Math.min(
          maxWidthUnits ?? Number.POSITIVE_INFINITY,
          Math.round(width / zoom),
        );
        positionHandle();
      };
      const onEnd = (): void => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        node.focus({ preventScroll: true });
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    };
    handle.addEventListener('pointerdown', onResizeDown);

    const handleInput = (): void => {
      // Ephemeral-only: autogrow the textarea; never touches the model,
      // dirty state, or the render scheduler.
      if (node instanceof HTMLTextAreaElement) clampHeight(node, view.y);
      positionHandle();
    };
    const handleCompositionStart = (): void => {
      composing = true;
    };
    const handleCompositionEnd = (): void => {
      // End of IME composition only clears the guard; the commit itself
      // stays on the explicit gesture path so text lands exactly once.
      composing = false;
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      // IME tradeoff: only plain Enter is
      // composition-guarded. Esc / Ctrl+Enter / blur commit even
      // mid-composition by design (no-loss beats in-flight composition
      // fidelity); exactly-once still holds via the settled flag in
      // commitOnce, and compositionend alone never commits.
      const isComposingNow = composing || event.isComposing === true;
      if (event.key === 'Escape') {
        // Esc commits pending text (never discards).
        event.preventDefault();
        commitOnce();
        return;
      }
      const modCommit =
        (event.ctrlKey === true || event.metaKey === true) &&
        event.key === 'Enter';
      if (modCommit) {
        event.preventDefault();
        commitOnce();
        return;
      }
      if (event.key === 'Enter' && !isComposingNow) {
        if (!multiline) {
          // Single-line: Enter commits (distinct from newline).
          event.preventDefault();
          commitOnce();
        }
        // Multiline: plain Enter inserts a newline (default). Never
        // preventDefault here so IME + newline stay native.
      }
      // While composing, all other keys stay native (IME owns them).
    };
    // WebKit often omits relatedTarget when touch activates formatting
    // chrome. Remember the interaction owner rather than relying on blur.
    let formattingOwnsFocus = false;
    let preserveEditorFocus = false;
    const editableTarget = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable="true"]') !==
        null;
    const restoreEditorFocus = (): void => {
      if (
        preserveEditorFocus &&
        editor === node &&
        document.activeElement !== node
      )
        node.focus({ preventScroll: true });
    };
    const releasePointerFocus = (): void => {
      preserveEditorFocus = false;
    };
    const handleFormattingClick = (event: Event): void => {
      if (
        options.keepOpenForTarget?.(event.target) &&
        !editableTarget(event.target)
      )
        restoreEditorFocus();
    };
    const handleBlur = (event: Event): void => {
      if (
        event instanceof FocusEvent &&
        (options.keepOpenForTarget?.(event.relatedTarget) ||
          (event.relatedTarget === null && formattingOwnsFocus))
      )
        return;
      // Click-away commits without loss. Exactly-once guarded.
      commitOnce();
    };
    const handleOutside = (event: Event): void => {
      if (event.target === node || event.target === handle) {
        if (event.type === 'pointerdown' || !preserveEditorFocus) {
          formattingOwnsFocus = false;
          preserveEditorFocus = false;
        }
        return;
      }
      if (options.keepOpenForTarget?.(event.target)) {
        formattingOwnsFocus = true;
        if (event.type === 'pointerdown')
          preserveEditorFocus = !editableTarget(event.target);
        if (event.type === 'focusin' && !editableTarget(event.target))
          restoreEditorFocus();
        // Buttons operate on the draft without moving its caret or dismissing
        // the keyboard. Inputs/selects retain their native focus behavior.
        if (
          event.type === 'pointerdown' &&
          event.target instanceof Element &&
          event.target.closest('button') !== null &&
          event.cancelable
        )
          event.preventDefault();
        return;
      }
      formattingOwnsFocus = false;
      preserveEditorFocus = false;
      commitOnce();
    };
    // Paste stays fully native: no interception, no sanitize —
    // breaks survive verbatim through the commit normalizer.

    node.addEventListener('input', handleInput);
    node.addEventListener('compositionstart', handleCompositionStart);
    node.addEventListener('compositionend', handleCompositionEnd);
    node.addEventListener('keydown', handleKeyDown as EventListener);
    node.addEventListener('blur', handleBlur);
    document.addEventListener('pointerdown', handleOutside, true);
    document.addEventListener('focusin', handleOutside);
    document.addEventListener('click', handleFormattingClick, true);
    document.addEventListener('keydown', releasePointerFocus, true);
    removeListeners = () => {
      node.removeEventListener('input', handleInput);
      node.removeEventListener('compositionstart', handleCompositionStart);
      node.removeEventListener('compositionend', handleCompositionEnd);
      node.removeEventListener('keydown', handleKeyDown as EventListener);
      node.removeEventListener('blur', handleBlur);
      document.removeEventListener('pointerdown', handleOutside, true);
      document.removeEventListener('focusin', handleOutside);
      document.removeEventListener('click', handleFormattingClick, true);
      document.removeEventListener('keydown', releasePointerFocus, true);
      handle.removeEventListener('pointerdown', onResizeDown);
    };

    try {
      node.focus({ preventScroll: true });
      const end = node.value.length;
      if (request.selectAll === true) {
        node.select();
      } else if (typeof node.setSelectionRange === 'function') {
        try {
          node.setSelectionRange(end, end);
        } catch {
          // Selection placement never breaks open.
        }
      }
    } catch {
      // Focus/IME summoning never breaks open.
    }
    // Caret-visibility assist: nudge the nearest internal scroller just
    // enough to expose the editor. The host-owned inset shortening
    //  does the real work; this never scrolls <html>/<body>.
    try {
      if (typeof node.scrollIntoView === 'function') {
        const html = document.documentElement;
        const body = document.body;
        let ancestor: HTMLElement | null = node.parentElement;
        let scroller: HTMLElement | null = null;
        while (ancestor !== null && ancestor !== html && ancestor !== body) {
          const style = getComputedStyle(ancestor);
          const oy = style.overflowY;
          if (
            (oy === 'auto' || oy === 'scroll') &&
            ancestor.scrollHeight > ancestor.clientHeight
          ) {
            scroller = ancestor;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        if (scroller !== null) {
          const r = node.getBoundingClientRect();
          const s = scroller.getBoundingClientRect();
          if (r.bottom > s.bottom || r.top < s.top) {
            node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        }
      }
    } catch {
      // Caret assist never breaks open.
    }
  }

  function openEdit(request: Omit<TextOverlayEditRequest, 'kind'>): void {
    openRequest({ ...request, kind: 'edit' });
  }

  return {
    openRequest,
    openEdit,
    close,
    isOpen: () => editor !== null,
    currentMode: () => mode,
    editingId: () => editId,
    updateAppearance: (appearance) => updateAppearance?.(appearance),
    dispose: () => {
      disposed = true;
      discard();
    },
  };
}
