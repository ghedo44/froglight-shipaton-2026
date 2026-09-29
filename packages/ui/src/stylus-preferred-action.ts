/**
 * Semantic preferred-action router.
 *
 * One decision point for Apple Pencil `preferredAction` values so
 * `StylusAccessoryBinder` never grows another large inline switch. The
 * controller is framework-free and returns intents; the binder owns async
 * tool-execution generations and palette presentation.
 */

import type { DocumentToolSnapshot, StylusPreferredAction } from '@froglight/foundation';
import {
  findActiveSurfaceToolId,
  findSurfaceEraserControlId,
  isSurfaceEraserControl,
} from './stylus-accessory-helpers.js';
import type { StylusPaletteFocusMode } from './stylus-palette-model.js';

export type PreferredActionIntent =
  | { readonly kind: 'noop' }
  | { readonly kind: 'switchTool'; readonly pane: string; readonly id: string }
  | { readonly kind: 'openPalette'; readonly focusMode: StylusPaletteFocusMode }
  | { readonly kind: 'diagnostic'; readonly message: string };

function activeNonEraserId(snapshot: DocumentToolSnapshot): string | null {
  const active = findActiveSurfaceToolId(snapshot);
  if (active === null) return null;
  for (const control of snapshot.controls) {
    if (control.kind !== 'button') continue;
    if (control.id !== active) continue;
    if (isSurfaceEraserControl(control)) return null;
    return active;
  }
  return active;
}

/**
 * Per-pane persistent state for `switchEraser` (stays on eraser until the
 * next toggle) and `switchPrevious` (small surface-tool history). Kept
 * independent from the momentary physical-eraser state machine.
 */
export class StylusPreferredActionController {
  /** Persistent eraser restore: pane → previous non-eraser tool. */
  private readonly eraserRestore = new Map<string, string>();
  /** Surface tool history: pane → ordered recent tool ids (max 8). */
  private readonly history = new Map<string, string[]>();
  readonly diagnostics: string[] = [];

  /** Feed the history from the latest snapshot (call on snapshot reads). */
  noteSnapshot(pane: string, snapshot: DocumentToolSnapshot): void {
    const active = findActiveSurfaceToolId(snapshot);
    if (active === null) return;
    const trail = this.history.get(pane) ?? [];
    if (trail[trail.length - 1] !== active) {
      trail.push(active);
      while (trail.length > 8) trail.shift();
      this.history.set(pane, trail);
    }
    // A manual tool change invalidates stale persistent-eraser restore when
    // the user leaves the eraser by hand.
    const restore = this.eraserRestore.get(pane);
    if (restore !== undefined && active !== restore) {
      const eraserId = findSurfaceEraserControlId(snapshot);
      if (eraserId !== null && active !== eraserId) {
        // User picked a new non-eraser tool: it becomes the restore base.
        // Keep the map entry only while on the eraser.
        this.eraserRestore.delete(pane);
      }
    }
  }

  previousTool(pane: string, currentId: string | null): string | null {
    const trail = this.history.get(pane) ?? [];
    for (let i = trail.length - 1; i >= 0; i -= 1) {
      const candidate = trail[i];
      if (candidate !== undefined && candidate !== currentId) return candidate;
    }
    return null;
  }

  routeDoubleTap(
    preferredAction: StylusPreferredAction | undefined,
    pane: string | null,
    snapshot: DocumentToolSnapshot | null,
  ): PreferredActionIntent {
    if (preferredAction === undefined || preferredAction === 'ignore' || preferredAction === 'unknown') {
      return { kind: 'noop' };
    }
    if (pane === null || snapshot === null) return { kind: 'noop' };
    switch (preferredAction) {
      case 'switchEraser':
        return this.persistentEraserIntent(pane, snapshot);
      case 'switchPrevious': {
        const current = findActiveSurfaceToolId(snapshot);
        const previous = this.previousTool(pane, current);
        if (previous === null) return { kind: 'noop' };
        // Never restore a tool that no longer exists.
        const ids = new Set(snapshot.controls.map((control) => control.id));
        if (!ids.has(previous)) return { kind: 'noop' };
        return { kind: 'switchTool', pane, id: previous };
      }
      case 'showColorPalette':
        return { kind: 'openPalette', focusMode: 'color' };
      case 'showInkAttributes':
        return { kind: 'openPalette', focusMode: 'attributes' };
      case 'showContextualPalette':
        return { kind: 'openPalette', focusMode: 'full' };
      case 'runSystemShortcut':
        this.diagnostics.push('runSystemShortcut: left to the system');
        return { kind: 'diagnostic', message: 'runSystemShortcut: left to the system' };
      default:
        return { kind: 'noop' };
    }
  }

  routeSqueezeEnded(
    _preferredAction: StylusPreferredAction | undefined,
    _pane: string | null,
    _snapshot: DocumentToolSnapshot | null,
  ): PreferredActionIntent {
    // Absolute-toggle contract: physical squeeze is owned by FrogLight
    // palette toggling and never executes a discrete tool action.
    // Double-tap keeps its own persistent semantics via routeDoubleTap;
    // squeeze callers must toggle (open/close) instead of routing here.
    void _preferredAction;
    void _pane;
    void _snapshot;
    return { kind: 'noop' };
  }

  private persistentEraserIntent(
    pane: string,
    snapshot: DocumentToolSnapshot,
  ): PreferredActionIntent {
    const eraserId = findSurfaceEraserControlId(snapshot);
    if (eraserId === null) return { kind: 'noop' };
    const activeId = findActiveSurfaceToolId(snapshot);
    const ids = new Set(snapshot.controls.map((control) => control.id));
    if (activeId === eraserId) {
      const restore = this.eraserRestore.get(pane) ?? this.previousTool(pane, eraserId);
      if (restore === null || restore === undefined || !ids.has(restore)) {
        return { kind: 'noop' };
      }
      this.eraserRestore.delete(pane);
      return { kind: 'switchTool', pane, id: restore };
    }
    const previous = activeNonEraserId(snapshot);
    if (previous !== null) this.eraserRestore.set(pane, previous);
    return { kind: 'switchTool', pane, id: eraserId };
  }

  /** Clear per-pane state when a pane/document disappears. */
  clearPane(pane: string): void {
    this.eraserRestore.delete(pane);
    this.history.delete(pane);
  }
}
