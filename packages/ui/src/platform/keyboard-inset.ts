/**
 * Overlay keyboard shell controller.
 *
 * Maintains `--fl-keyboard-inset-height` once per keyboard transition and
 * glides registered nodes on the compositor (FLIP) instead of reflowing
 * every frame — a per-frame reflow is what makes long lists (especially
 * `column-reverse` ones) lag and tremble as the keyboard moves.
 *
 * State flows from the `KeyboardInsetService` behind `keyboardInsetToken`
 * (native direct-eval hook, `visualViewport` fallback, or tests). This
 * module owns DOM only and never imports Tauri or React,.
 *
 * Attach once per shell (`attachKeyboardShell`, disposed with the mount);
 * components register through the module helpers, which no-op without an
 * attached shell so headless compositions stay inert.
 *
 * Behavior derived from `dash-chat/tauri-plugin-virtual-keyboard`
 * (MIT OR Apache-2.0); reimplemented as Froglight-owned code with no
 * dependency on that repository.
 */

import type {
  KeyboardInsetMeasurement,
  KeyboardInsetService,
  KeyboardInsetTargetEvent,
  KeyboardInsetWillHideEvent,
} from '@froglight/foundation';
import {
  createCaretGuard,
  ensureFocusedEditableVisible,
  isKeyboardEditable,
} from './keyboard/focus.js';
import { bandHeightFor, isOpaqueBackground } from './keyboard/band.js';
import { glideDurationFor } from './keyboard/flip-animator.js';
import { selectSlotInset } from './keyboard/slots.js';
import { resetPanGuard } from './keyboard/ios-viewport-pan-guard.js';
import { isMotionReduced } from '../motion.js';

export const KEYBOARD_INSET_VAR = '--fl-keyboard-inset-height';

// Matches each OS's IME animation so content tracks the keyboard's edge.
// On Android willShow reaches JS a few frames after the animation starts
// (direct-eval delivery), so the glide is clamped short of the reported
// duration and uses an emphasized-decelerate curve that front-loads
// progress to make up the late start. The clamp also bounds the damage on
// OEM keyboards whose visual animation is far shorter than reported —
// trailing the keyboard slightly is the safe direction (it hides behind
// the keyboard); leading would paint a background band. iOS keeps the
// historical approximation of its keyboard curve and reported duration.
const CURVE_ANDROID = 'cubic-bezier(0.2, 0, 0, 1)';
const CURVE_DEFAULT = 'cubic-bezier(0.38, 0.7, 0.125, 1)';
const SETTLE_CORRECT_MS = 150;
const SWAP_BACKSTOP_MS = 500;

export interface KeyboardShellOptions {
  readonly store: KeyboardInsetService | null;
  /** Injectable document (tests); defaults to the global document. */
  readonly doc?: Document;
  /** Injectable platform hint (tests); defaults to the user agent. */
  readonly isAndroid?: boolean;
  /** Injectable reduced-motion hint (tests); defaults to app/system preference. */
  readonly reduceMotion?: boolean;
}

export interface BelowKeyboardSurface {
  /** Open/close the surface, gliding everything registered above it. */
  setOpen(open: boolean): void;
  /** Whether the region is visible (open, or held mid-swap). */
  isVisible(): boolean;
  onVisibleChange(listener: (visible: boolean) => void): () => void;
  destroy(): void;
}

/**
 * The bottom inset the layout is heading to, in CSS px — updated
 * synchronously at intent time (willShow/willHide/slot changes), before
 * the reflow that applies it. Geometry-derived state can correct mid-glide
 * reads with `applied − target`, independent of when it recomputes.
 */
let insetTarget = 0;

export function currentKeyboardInsetTarget(): number {
  return insetTarget;
}

interface HeldSurface {
  node: HTMLElement;
  onHidden?: () => void;
  shade?: HTMLElement;
}

class ShellController {
  private readonly store: KeyboardInsetService | null;
  private readonly doc: Document;
  private readonly curve: string;
  private readonly reduceMotion: boolean | undefined;
  private readonly caret = createCaretGuard();
  private readonly unsubs: Array<() => void> = [];
  private readonly nodes = new Set<HTMLElement>();
  private readonly resyncs = new Set<() => void>();
  private readonly restoreSuppressors = new Set<object>();
  private parkedRestore: (() => void) | null = null;
  // The keyboard, below-keyboard surfaces, and slot holds share one bottom
  // slot: while any claim is active the slot owns the reserved height in
  // the keyboard's place, otherwise the keyboard owns it.
  private keyboardHeight = 0;
  // Quality of the last target: `exact` occlusion applies the final inset
  // immediately (logical geometry first), `hint` keeps the delayed layout.
  private measurement: KeyboardInsetMeasurement = 'hint';
  private readonly slotClaims = new Set<object>();
  private surfaceHeight = 0;
  private lastDurationMs = 250;
  private pendingKeyboard = false;
  private pendingKeyboardTimer: ReturnType<typeof setTimeout> | undefined;
  private flipGeneration = 0;
  private band: HTMLElement | null = null;
  private bandFloor = 0;
  private heldSurface: HeldSurface | null = null;
  private heldSurfaceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastEditable: HTMLElement | null = null;
  private disposed = false;
  private readonly isAndroid: boolean;

  constructor(options: KeyboardShellOptions) {
    const globalDoc = typeof document === 'undefined' ? null : document;
    if (!options.doc && !globalDoc) {
      throw new Error('attachKeyboardShell requires a document');
    }
    this.store = options.store;
    this.doc = options.doc ?? globalDoc!;
    const userAgent =
      typeof navigator === 'undefined' ? '' : navigator.userAgent;
    const isAndroid = options.isAndroid ?? /android/i.test(userAgent);
    this.curve = isAndroid ? CURVE_ANDROID : CURVE_DEFAULT;
    this.reduceMotion = options.reduceMotion;
    this.isAndroid = isAndroid;
    this.ensureBand();
    this.trackEditable();
    if (this.store !== null) {
      const store = this.store;
      this.unsubs.push(
        store.onTargetChange((event) => {
          this.onTarget(event);
        }),
        store.onWillHide((event) => {
          this.onWillHide(event);
        }),
        store.onSettled((height) => {
          this.onSettled(height);
        }),
        store.subscribe((snapshot) => {
          // Backstop for a missed willHide: didHide (or any authoritative
          // close) reaches the shell only through this snapshot, so a
          // closed store must reset shell geometry even when no hide
          // animation ran.
          if (!snapshot.isOpen) this.syncShellToClosedStore();
          // Reserved height learned/changed while a surface is mounted:
          // re-sync open surfaces against it.
          for (const resync of this.resyncs) resync();
        }),
      );
    }
  }

  private glideDuration(durationMs: number): number {
    return glideDurationFor({
      durationMs,
      isAndroid: this.isAndroid,
      reduceMotion: this.reduceMotion ?? isMotionReduced(this.doc),
    });
  }

  private root(): HTMLElement {
    return this.doc.documentElement;
  }

  // -- background band -------------------------------------------------

  /** Paint the keyboard's region with the app surface so rounded keyboard
   * corners blend into the app instead of revealing the transparent
   * WebView base. Zero-height while the keyboard is down, so it never
   * covers a full-bleed surface behind the WebView. */
  private ensureBand(): void {
    if (this.band || !this.doc.body) return;
    const band = this.doc.createElement('div');
    band.setAttribute('data-fl-keyboard-band', '');
    band.style.position = 'fixed';
    band.style.bottom = '0';
    band.style.left = '0';
    band.style.right = '0';
    band.style.height = '0';
    band.style.background = 'transparent';
    band.style.pointerEvents = 'none';
    this.doc.body.prepend(band);
    this.band = band;
  }

  private setBandFloor(px: number): void {
    this.bandFloor = px;
    if (this.band) {
      this.band.style.height = `${Math.max(this.currentBandHeight(), 0)}px`;
    }
  }

  private currentBandHeight(): number {
    return bandHeightFor(this.keyboardHeightSnapshot(), this.bandFloor);
  }

  private keyboardHeightSnapshot(): number {
    // Prefer the shell's local height over the store snapshot: during
    // `willHide` the store still reports the open height while intent
    // listeners run (so the FLIP can use the geometry), but the band must
    // already collapse. Local state is updated synchronously in every
    // event path, so it is the animated truth.
    return this.keyboardHeight;
  }

  private paintBand(): void {
    if (!this.band) return;
    this.band.style.height = `${this.currentBandHeight()}px`;
    if (this.currentBandHeight() > 0) {
      // Re-sample after paint so the band follows theme/route changes for
      // free; deferred out of the willShow hot path (hit-test forces
      // layout) and invisible anyway behind the rising keyboard.
      const band = this.band;
      requestAnimationFrame(() => {
        if (band.isConnected && this.currentBandHeight() > 0) {
          band.style.background = this.detectFillColor();
        }
      });
    }
  }

  /** Hit-test just above the keyboard's top edge for the first full-width
   * opaque background behind a transparent composer bar. */
  private detectFillColor(): string {
    const view = this.doc.defaultView;
    if (!view || typeof this.doc.elementsFromPoint !== 'function') {
      return 'transparent';
    }
    const height = this.currentBandHeight();
    const x = Math.floor(view.innerWidth / 2);
    const y = view.innerHeight - height - 2;
    for (const el of this.doc.elementsFromPoint(x, y)) {
      if (!(el instanceof HTMLElement)) continue;
      const bg = view.getComputedStyle(el).backgroundColor;
      const opaque = isOpaqueBackground(bg);
      const fullWidth =
        el.getBoundingClientRect().width >= view.innerWidth * 0.9;
      if (opaque && fullWidth) return bg;
    }
    return 'transparent';
  }

  private trackEditable(): void {
    const onFocusIn = (event: FocusEvent) => {
      if (isKeyboardEditable(event.target)) {
        this.lastEditable = event.target;
      }
    };
    this.doc.addEventListener('focusin', onFocusIn);
    this.unsubs.push(() => {
      this.doc.removeEventListener('focusin', onFocusIn);
    });
  }

  // -- inset application ------------------------------------------------

  private slotClaimed(): boolean {
    return this.slotClaims.size > 0;
  }

  private computeInset(): number {
    return selectSlotInset({
      slotClaimed: this.slotClaimed(),
      pendingKeyboard: this.pendingKeyboard,
      surfaceHeight: this.surfaceHeight,
      keyboardHeight: this.keyboardHeight,
    });
  }

  private applyInset(): void {
    const px = this.computeInset();
    insetTarget = px;
    this.root().style.setProperty(KEYBOARD_INSET_VAR, `${px}px`);
    this.root().dataset.flKeyboardOpen = px > 0 ? 'true' : 'false';
  }

  // -- FLIP glide --------------------------------------------------------

  /**
   * Put nodes back in plain layout space once the glide lands and hand the
   * caret back. Dropping the transform also clears the transition, so a
   * later layout change cannot inherit it and animate when it should not.
   * `transitionend` is the exact landing moment; the timeout is only a
   * backstop for when it cannot fire.
   */
  private scheduleSettle(
    toClear: Iterable<HTMLElement>,
    durationMs: number,
    generation: number,
    applyInsetOnSettle = false,
  ): void {
    const removers: Array<() => void> = [];
    const run = () => {
      clearTimeout(timer);
      for (const remove of removers) remove();
      removers.length = 0;
      if (generation !== this.flipGeneration || this.disposed) return;
      // A layout-at-end glide swaps the glided transforms for the real
      // layout here, in one paint — unless content changed mid-glide, in
      // which case a short follow-up glide carries the nodes the rest of
      // the way (and owns clearing + caret restore when it lands).
      if (
        applyInsetOnSettle &&
        this.correctSettleDriftInner(toClear, generation)
      ) {
        return;
      }
      for (const node of toClear) {
        node.style.transition = '';
        node.style.transform = '';
      }
      void this.root().getBoundingClientRect();
      this.caret.restore();
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName === 'transform') run();
    };
    for (const node of toClear) {
      node.addEventListener('transitionend', onTransitionEnd);
      removers.push(() => {
        node.removeEventListener('transitionend', onTransitionEnd);
      });
    }
    const timer = setTimeout(run, durationMs + 50);
  }

  private correctSettleDriftInner(
    toClear: Iterable<HTMLElement>,
    generation: number,
  ): boolean {
    const glided = new Map<HTMLElement, number>();
    for (const node of toClear) {
      glided.set(node, node.getBoundingClientRect().top);
    }
    this.applyInset();
    for (const node of toClear) {
      node.style.transition = 'none';
      node.style.transform = '';
    }
    const drifts = new Map<HTMLElement, number>();
    let maxDrift = 0;
    for (const node of toClear) {
      const drift = (glided.get(node) ?? 0) - node.getBoundingClientRect().top;
      drifts.set(node, drift);
      maxDrift = Math.max(maxDrift, Math.abs(drift));
    }
    if (maxDrift <= 1) return false;
    for (const node of toClear) {
      const drift = drifts.get(node) ?? 0;
      node.style.transform = drift ? `translateY(${drift}px)` : '';
    }
    void this.root().getBoundingClientRect();
    requestAnimationFrame(() => {
      if (generation !== this.flipGeneration || this.disposed) return;
      for (const node of toClear) {
        node.style.transition = `transform ${SETTLE_CORRECT_MS}ms ${this.curve}`;
        node.style.transform = '';
      }
      this.scheduleSettle(toClear, SETTLE_CORRECT_MS, generation);
    });
    return true;
  }

  /**
   * Animate a keyboard-driven layout change without ever animating a
   * reflow. The inset var changes in one shot (one reflow); registered
   * nodes are FLIPped — inverse transform applied so each looks unmoved,
   * then transitioned away so it glides on the compositor in sync with
   * the native keyboard. Travel is measured per node, not computed from
   * the inset delta. `layoutAtEnd` is the show path: the old layout
   * persists through the glide and the reflow lands under the fully-risen
   * keyboard. Hide reflows up front so the vacated region exists to glide
   * down into.
   */
  private flip(
    durationMs: number,
    layoutAtEnd = false,
    entering?: HTMLElement,
  ): void {
    durationMs = this.glideDuration(durationMs);
    const generation = ++this.flipGeneration;
    const doc = this.doc;
    // WKWebView mis-renders a caret whose ancestor is mid-transform; keep
    // the focused caret's node on its own GPU layer for the glide.
    const active = doc.activeElement;
    const layered = new Set<HTMLElement>();
    for (const node of this.nodes) {
      if (active instanceof HTMLElement && node.contains(active)) {
        layered.add(node);
      }
    }
    this.caret.restore();
    if (layered.size > 0 && active instanceof HTMLElement) {
      this.caret.hide(active);
    }

    insetTarget = this.computeInset();

    const firsts = new Map<HTMLElement, number>();
    for (const node of this.nodes) {
      firsts.set(node, node.getBoundingClientRect().top);
    }
    for (const node of this.nodes) {
      node.style.transition = 'none';
      node.style.transform = '';
    }

    if (layoutAtEnd) {
      const oldTops = new Map<HTMLElement, number>();
      for (const node of this.nodes) {
        oldTops.set(node, node.getBoundingClientRect().top);
      }
      // Measure the future without ever painting it: apply, read, revert.
      const prevInset = this.root().style.getPropertyValue(KEYBOARD_INSET_VAR);
      this.root().style.setProperty(
        KEYBOARD_INSET_VAR,
        `${this.computeInset()}px`,
      );
      const lasts = new Map<HTMLElement, number>();
      for (const node of this.nodes) {
        lasts.set(node, node.getBoundingClientRect().top);
      }
      this.root().style.setProperty(KEYBOARD_INSET_VAR, prevInset);
      for (const node of this.nodes) {
        const start = (firsts.get(node) ?? 0) - (oldTops.get(node) ?? 0);
        node.style.transform = layered.has(node)
          ? `translate3d(0, ${start}px, 0)`
          : start
            ? `translateY(${start}px)`
            : '';
      }
      void this.root().getBoundingClientRect();
      // Play on the next frame: transitions backdate their start to the
      // style change's timestamp, so starting inside this (expensive) task
      // would burn the first chunk of the animation.
      requestAnimationFrame(() => {
        if (generation !== this.flipGeneration || this.disposed) return;
        for (const node of this.nodes) {
          const oldTop = oldTops.get(node) ?? 0;
          const end = (lasts.get(node) ?? oldTop) - oldTop;
          node.style.transition = `transform ${durationMs}ms ${this.curve}`;
          node.style.transform = layered.has(node)
            ? `translate3d(0, ${end}px, 0)`
            : end
              ? `translateY(${end}px)`
              : '';
        }
        this.scheduleSettle(this.nodes, durationMs, generation, true);
      });
      return;
    }

    this.applyInset();
    const lasts = new Map<HTMLElement, number>();
    for (const node of this.nodes) {
      lasts.set(node, node.getBoundingClientRect().top);
    }
    let travel = 0;
    for (const node of this.nodes) {
      const last = lasts.get(node) ?? 0;
      const delta = (firsts.get(node) ?? last) - last;
      if (Math.abs(delta) > Math.abs(travel)) travel = delta;
      node.style.transform = layered.has(node)
        ? `translate3d(0, ${delta}px, 0)`
        : delta
          ? `translateY(${delta}px)`
          : '';
    }
    // Measured from the movers rather than the inset delta; translate3d so
    // WebKit composites the fixed entering surface and animates the slide.
    if (entering && travel) {
      entering.style.transform = `translate3d(0, ${travel}px, 0)`;
    }
    const gliding: Iterable<HTMLElement> = entering
      ? [...this.nodes, entering]
      : this.nodes;
    void this.root().getBoundingClientRect();
    requestAnimationFrame(() => {
      if (generation !== this.flipGeneration || this.disposed) return;
      for (const node of this.nodes) {
        node.style.transition = `transform ${durationMs}ms ${this.curve}`;
        node.style.transform = layered.has(node) ? 'translate3d(0, 0, 0)' : '';
      }
      if (entering) {
        entering.style.transition = `transform ${durationMs}ms ${this.curve}`;
        entering.style.transform = 'translate3d(0, 0, 0)';
      }
      this.scheduleSettle(gliding, durationMs, generation);
    });
  }

  // -- native event wiring -------------------------------------------------

  private revealCaret(): void {
    // Preventing root WebView scrolling means Froglight owns caret
    // visibility: scroll the nearest internal ancestor just enough, never
    // the application shell. Deferred past the inset reflow so geometry is
    // final; failure is invisible (keyboard still clears the layout).
    const height = this.keyboardHeight;
    if (height <= 0) return;
    const doc = this.doc;
    queueMicrotask(() => {
      if (this.disposed) return;
      try {
        ensureFocusedEditableVisible(doc, height);
      } catch {
        // Caret visibility must never break keyboard layout.
      }
    });
  }

  private onTarget(event: KeyboardInsetTargetEvent): void {
    // One physical transition must trigger one FLIP animation: repeated
    // notifications carrying identical geometry are deduped here. A
    // genuinely new height (rotation, emoji, predictive bar) flows through
    // as a target change without resetting to zero.
    this.measurement = event.measurement;
    if (event.height === this.keyboardHeight && !this.slotClaimed()) {
      return;
    }
    this.keyboardHeight = event.height;
    this.lastDurationMs = event.durationMs;
    this.clearPendingKeyboard();
    if (this.heldSurface?.shade) {
      this.raiseShade(
        this.heldSurface.node,
        this.heldSurface.shade,
        event.height,
        this.glideDuration(event.durationMs),
      );
    }
    this.resolveHeldSurface(this.glideDuration(event.durationMs) + 50);
    this.paintBand();
    // Logical geometry first, visual interpolation second: exact iOS
    // geometry applies the final inset immediately so the editor's scroll
    // viewport already represents the usable area while the keyboard rises
    // (one target reflow, compositor glide only). Hint geometry (Android's
    // late direct-eval signal) keeps the delayed layout-at-end path.
    if (!this.slotClaimed()) {
      if (this.measurement === 'exact') this.flip(event.durationMs, false);
      else this.flip(event.durationMs, true);
    }
    this.revealCaret();
  }

  private onWillHide(event: KeyboardInsetWillHideEvent): void {
    this.keyboardHeight = 0;
    this.lastDurationMs = event.durationMs;
    this.measurement = 'hint';
    this.clearPendingKeyboard();
    this.resolveHeldSurface(0);
    this.paintBand();
    // Compatibility compensation is reset synchronously on hide so no pan
    // offset lingers after dismissal.
    resetPanGuard(this.doc);
    if (!this.slotClaimed()) this.flip(event.durationMs);
  }

  private onSettled(settled: number): void {
    if (settled === this.keyboardHeight) return;
    this.keyboardHeight = settled;
    this.paintBand();
    if (settled === 0) resetPanGuard(this.doc);
    if (!this.slotClaimed() && !this.pendingKeyboard) {
      this.flip(this.lastDurationMs);
    }
    this.revealCaret();
  }

  /**
   * Sync shell truth to a closed store without a hide animation: drop any
   * stale height immediately with a final non-animated correction. A
   * claimed slot keeps holding layout, but the stale height is still
   * dropped so a later claim release cannot restore it.
   */
  private syncShellToClosedStore(): void {
    const wasOpen = this.keyboardHeight > 0;
    this.keyboardHeight = 0;
    this.measurement = 'hint';
    if (!wasOpen || this.slotClaimed()) return;
    this.clearPendingKeyboard();
    this.paintBand();
    resetPanGuard(this.doc);
    this.flip(0);
  }

  // -- slot claims ----------------------------------------------------------

  private clearPendingKeyboard(): void {
    this.pendingKeyboard = false;
    if (this.pendingKeyboardTimer !== undefined) {
      clearTimeout(this.pendingKeyboardTimer);
      this.pendingKeyboardTimer = undefined;
    }
  }

  private dropHeldSurface(node?: HTMLElement): void {
    if (node && this.heldSurface?.node !== node) return;
    if (this.heldSurface?.shade) this.resetShade(this.heldSurface.shade);
    this.heldSurface = null;
    if (this.heldSurfaceTimer !== undefined) {
      clearTimeout(this.heldSurfaceTimer);
      this.heldSurfaceTimer = undefined;
    }
  }

  private resolveHeldSurface(delayMs: number): void {
    const held = this.heldSurface;
    if (!held) return;
    if (this.heldSurfaceTimer !== undefined) {
      clearTimeout(this.heldSurfaceTimer);
    }
    this.heldSurfaceTimer = setTimeout(() => {
      if (this.heldSurface !== held || this.disposed) return;
      this.heldSurface = null;
      held.node.style.height = '0px';
      if (held.shade) this.resetShade(held.shade);
      held.onHidden?.();
    }, delayMs);
  }

  /** Opaque cover sliding up over a held surface in lockstep with the
   * reclaiming keyboard, so content does not ghost through its blur. */
  private raiseShade(
    node: HTMLElement,
    shade: HTMLElement,
    height: number,
    durationMs: number,
  ): void {
    const view = this.doc.defaultView;
    if (view)
      shade.style.background = view.getComputedStyle(node).backgroundColor;
    shade.style.transition = 'none';
    shade.style.height = `${height}px`;
    shade.style.transform = `translate3d(0, ${height}px, 0)`;
    void shade.getBoundingClientRect();
    requestAnimationFrame(() => {
      if (this.disposed) return;
      shade.style.transition = `transform ${durationMs}ms ${this.curve}`;
      shade.style.transform = 'translate3d(0, 0, 0)';
    });
  }

  private resetShade(shade: HTMLElement): void {
    shade.style.transition = 'none';
    shade.style.transform = 'translate3d(0, 0, 0)';
    shade.style.height = '0px';
  }

  private editableFocused(): boolean {
    return isKeyboardEditable(this.doc.activeElement);
  }

  private reservedHeight(): number {
    return this.store?.snapshot().reservedHeight ?? this.surfaceHeight;
  }

  private setSlotClaim(
    claim: object,
    active: boolean,
    entering?: HTMLElement,
  ): boolean {
    this.surfaceHeight = this.reservedHeight();
    const wasClaimed = this.slotClaimed();
    if (active) this.slotClaims.add(claim);
    else this.slotClaims.delete(claim);
    if (this.slotClaimed() === wasClaimed) return false;
    if (active) this.dismissKeyboard();
    if (!active && this.keyboardHeight === 0 && this.editableFocused()) {
      this.pendingKeyboard = true;
      if (this.pendingKeyboardTimer !== undefined) {
        clearTimeout(this.pendingKeyboardTimer);
      }
      this.pendingKeyboardTimer = setTimeout(() => {
        this.pendingKeyboard = false;
        this.resolveHeldSurface(0);
        this.flip(this.lastDurationMs);
      }, SWAP_BACKSTOP_MS);
      this.store?.show();
      return true;
    }
    this.clearPendingKeyboard();
    this.flip(this.lastDurationMs, false, entering);
    return false;
  }

  // -- public shell surface ---------------------------------------------------

  registerAbove(node: HTMLElement): () => void {
    this.nodes.add(node);
    return () => {
      this.nodes.delete(node);
      // Fully restore owned mutations so unregister never leaves a glide
      // transform/transition behind.
      node.style.transition = '';
      node.style.transform = '';
    };
  }

  registerBelow(node: HTMLElement): BelowKeyboardSurface {
    const previousOverflow = node.style.overflow;
    const previousHeight = node.style.height;
    const previousTransition = node.style.transition;
    const previousTransform = node.style.transform;
    node.style.overflow = 'hidden';
    const shade = this.doc.createElement('div');
    shade.style.position = 'absolute';
    shade.style.left = '0';
    shade.style.right = '0';
    shade.style.bottom = '0';
    shade.style.height = '0';
    shade.style.pointerEvents = 'none';
    node.appendChild(shade);

    const claim = {};
    let open = false;
    let destroyed = false;
    let visible = false;
    const visibleListeners = new Set<(visible: boolean) => void>();
    const setVisible = (next: boolean) => {
      if (visible === next) return;
      visible = next;
      for (const listener of visibleListeners) listener(next);
    };

    const sync = () => {
      if (destroyed || this.disposed) return;
      const reserved = this.reservedHeight();
      if (open) {
        this.dropHeldSurface(node);
        setVisible(true);
        node.style.height = `${reserved}px`;
        node.style.transition = 'none';
        node.style.transform = '';
        this.setSlotClaim(claim, true, node);
        return;
      }
      const held = this.setSlotClaim(claim, false);
      if (held) {
        this.heldSurface = {
          node,
          onHidden: () => {
            setVisible(false);
          },
          shade,
        };
        return;
      }
      if (this.heldSurface?.node === node) return;
      node.style.height = '0px';
      node.style.transition = 'none';
      node.style.transform = '';
      setVisible(false);
    };
    this.resyncs.add(sync);

    return {
      setOpen: (next: boolean) => {
        if (destroyed || next === open) return;
        open = next;
        sync();
      },
      isVisible: () => visible,
      onVisibleChange: (listener: (visible: boolean) => void) => {
        visibleListeners.add(listener);
        return () => {
          visibleListeners.delete(listener);
        };
      },
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        this.resyncs.delete(sync);
        visibleListeners.clear();
        this.dropHeldSurface(node);
        if (open) this.setSlotClaim(claim, false);
        // Restore every mutation owned by this registration.
        shade.remove();
        node.style.overflow = previousOverflow;
        node.style.height = previousHeight;
        node.style.transition = previousTransition;
        node.style.transform = previousTransform;
      },
    };
  }

  suppressRestore(): () => void {
    const token = {};
    this.restoreSuppressors.add(token);
    return () => {
      if (!this.restoreSuppressors.delete(token)) return;
      if (this.restoreSuppressors.size === 0 && this.parkedRestore !== null) {
        const restore = this.parkedRestore;
        this.parkedRestore = null;
        restore();
      }
    };
  }

  holdSlot(): () => void {
    if (!this.store || !this.store.snapshot().isOpen) return () => undefined;
    const active = this.doc.activeElement;
    const focused = isKeyboardEditable(active) ? active : this.lastEditable;
    const claim = {};
    this.setSlotClaim(claim, true);
    this.setBandFloor(this.surfaceHeight);
    let released = false;
    const restore = () => {
      if (focused?.isConnected) {
        focused.focus({ preventScroll: true });
        this.store?.show();
      }
    };
    return () => {
      if (released) return;
      released = true;
      queueMicrotask(() => {
        if (this.disposed) return;
        if (this.restoreSuppressors.size === 0) restore();
        else this.parkedRestore = restore;
        this.setBandFloor(0);
        this.setSlotClaim(claim, false);
      });
    };
  }

  dismissKeyboard(options: { keepFocus?: boolean } = {}): void {
    if (!this.store || !this.store.snapshot().isOpen) return;
    if (!options.keepFocus && this.doc.activeElement instanceof HTMLElement) {
      this.doc.activeElement.blur();
    }
    this.store.hide();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.clearPendingKeyboard();
    if (this.heldSurfaceTimer !== undefined) {
      clearTimeout(this.heldSurfaceTimer);
    }
    this.nodes.clear();
    this.resyncs.clear();
    this.slotClaims.clear();
    this.restoreSuppressors.clear();
    this.parkedRestore = null;
    this.heldSurface = null;
    this.band?.remove();
    this.band = null;
    this.root().style.removeProperty(KEYBOARD_INSET_VAR);
    delete this.root().dataset.flKeyboardOpen;
    resetPanGuard(this.doc);
    insetTarget = 0;
    this.measurement = 'hint';
  }
}

let active: ShellController | null = null;

/**
 * Attach the keyboard shell: subscribes to the store, maintains the inset
 * variable, and enables the module registration helpers. Dispose with the
 * mount. Re-attaching replaces the previous shell.
 */
export function attachKeyboardShell(options: KeyboardShellOptions): () => void {
  detachKeyboardShell();
  const controller = new ShellController(options);
  active = controller;
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    if (active === controller) active = null;
    controller.dispose();
  };
}

export function detachKeyboardShell(): void {
  if (active !== null) {
    const controller = active;
    active = null;
    controller.dispose();
  }
}

/**
 * Keep a node rendered above the keyboard: across transitions it glides on
 * the compositor instead of reflowing per frame. No-op without an attached
 * shell. Returns an unregister function.
 */
export function registerAboveKeyboard(node: HTMLElement): () => void {
  if (active === null) return () => undefined;
  return active.registerAbove(node);
}

/**
 * Render a node below the keyboard (media/emoji panel docking in the
 * keyboard slot). Must be a sibling — never inside — a node passed to
 * `registerAboveKeyboard`. No-op surface without an attached shell.
 */
export function registerBelowKeyboard(node: HTMLElement): BelowKeyboardSurface {
  if (active === null) {
    let open = false;
    return {
      setOpen: (next: boolean) => {
        open = next;
      },
      isVisible: () => open,
      onVisibleChange: () => () => undefined,
      destroy: () => undefined,
    };
  }
  return active.registerBelow(node);
}

/**
 * Retract the keyboard without giving up its slot (dialogs covering the
 * composer). Inert while the keyboard is closed. Returns the dismissal.
 */
export function holdKeyboardSlot(): () => void {
  if (active === null) return () => undefined;
  return active.holdSlot();
}

/** Park keyboard restores while the releaser is pending (covering dialog). */
export function suppressKeyboardRestore(): () => void {
  if (active === null) return () => undefined;
  return active.suppressRestore();
}

/** Hide an open keyboard, blurring focus so it does not rise again. */
export function dismissKeyboard(options: { keepFocus?: boolean } = {}): void {
  active?.dismissKeyboard(options);
}

export type {
  VisualViewportLike,
  VisualViewportSourceOptions,
} from './keyboard/viewport-source.js';
export { attachVisualViewportSource } from './keyboard/viewport-source.js';
