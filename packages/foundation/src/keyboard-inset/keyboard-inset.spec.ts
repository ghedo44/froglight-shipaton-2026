/**
 * Keyboard-inset capability tests:
 * - target/settled ingestion, hint reconciliation, malformed-payload safety
 * - swap-gap debounce for settled heights
 * - persisted reserved height (latest settled wins, storage failures inert)
 * - fiber lifecycle invariant for the token binding
 *   (activate → one binding, dispose → zero, reactivate → one)
 */

import { describe, expect, it, vi } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  KEYBOARD_INSET_FALLBACK_HEIGHT,
  KEYBOARD_INSET_STORAGE_KEY,
  computeKeyboardBottomInset,
  readKeyboardInsetMeasurement,
  reconcileKeyboardInsetTarget,
  type KeyboardInsetSnapshot,
} from './contract.js';
import { KeyboardInsetStore } from './store.js';
import { createKeyboardInset } from './plugin.js';
import { keyboardInsetToken } from '../tokens.js';

function snapshots(store: KeyboardInsetStore): KeyboardInsetSnapshot[] {
  const seen: KeyboardInsetSnapshot[] = [];
  store.subscribe((snapshot) => {
    seen.push(snapshot);
  });
  return seen;
}

describe('reconcileKeyboardInsetTarget', () => {
  it('trusts the settled height when the target is close (Gboard overshoot)', () => {
    expect(reconcileKeyboardInsetTarget(334, 300)).toBe(300);
  });

  it('takes a clearly different target (IME switch, orientation change)', () => {
    expect(reconcileKeyboardInsetTarget(200, 300)).toBe(200);
    expect(reconcileKeyboardInsetTarget(300, 0)).toBe(300);
  });
});

describe('computeKeyboardBottomInset', () => {
  const webView = { x: 0, y: 0, width: 1024, height: 768 };
  it('measures a full-width docked keyboard', () => {
    expect(
      computeKeyboardBottomInset(webView, {
        x: 0,
        y: 768 - 346,
        width: 1024,
        height: 346,
      }),
    ).toBe(346);
  });
  it('returns zero for a floating keyboard away from the bottom edge', () => {
    expect(
      computeKeyboardBottomInset(webView, {
        x: 300,
        y: 200,
        width: 400,
        height: 300,
      }),
    ).toBe(0);
  });
  it('measures partial bottom overlap only', () => {
    expect(
      computeKeyboardBottomInset(webView, {
        x: 700,
        y: 768 - 120,
        width: 400,
        height: 300,
      }),
    ).toBe(120);
  });
  it('returns zero when the keyboard is outside the WebView', () => {
    expect(
      computeKeyboardBottomInset(webView, {
        x: 0,
        y: 800,
        width: 1024,
        height: 300,
      }),
    ).toBe(0);
  });
  it('handles Stage Manager-sized windows and landscape', () => {
    const narrow = { x: 0, y: 0, width: 500, height: 700 };
    expect(
      computeKeyboardBottomInset(narrow, {
        x: 0,
        y: 700 - 250,
        width: 500,
        height: 250,
      }),
    ).toBe(250);
    const landscape = { x: 0, y: 0, width: 1180, height: 540 };
    expect(
      computeKeyboardBottomInset(landscape, {
        x: 0,
        y: 540 - 180,
        width: 1180,
        height: 180,
      }),
    ).toBe(180);
  });
  it('handles Split View, portrait, and partially intersecting keyboards', () => {
    // iPad Split View: narrow WebView with a full-width docked keyboard.
    const split = { x: 0, y: 0, width: 678, height: 1024 };
    expect(
      computeKeyboardBottomInset(split, {
        x: 0,
        y: 1024 - 350,
        width: 678,
        height: 350,
      }),
    ).toBe(350);
    // Portrait phone with a docked keyboard.
    const portrait = { x: 0, y: 0, width: 390, height: 844 };
    expect(
      computeKeyboardBottomInset(portrait, {
        x: 0,
        y: 844 - 336,
        width: 390,
        height: 336,
      }),
    ).toBe(336);
    // Slide Over-style partial intersection still counts bottom occlusion.
    expect(
      computeKeyboardBottomInset(split, {
        x: 500,
        y: 1024 - 200,
        width: 400,
        height: 300,
      }),
    ).toBe(200);
  });
  it('returns zero for zero-sized intersections', () => {
    expect(
      computeKeyboardBottomInset(webView, {
        x: 10,
        y: 10,
        width: 0,
        height: 0,
      }),
    ).toBe(0);
  });
});

describe('KeyboardInsetStore', () => {
  it('starts closed with the fallback reserved height', () => {
    const store = new KeyboardInsetStore();
    expect(store.snapshot()).toEqual({
      height: 0,
      isOpen: false,
      reservedHeight: KEYBOARD_INSET_FALLBACK_HEIGHT,
    });
    store.dispose();
  });

  it('announces the target with the reconciled height and tracks willHide', () => {
    const store = new KeyboardInsetStore();
    const announced: Array<{ height: number; durationMs: number; measurement: string }> = [];
    store.onTargetChange((event) => {
      announced.push(event);
    });
    let hidden = 0;
    store.onWillHide(() => {
      hidden += 1;
    });
    store.handleNativeEvent('target', { height: 300, durationMs: 250 });
    expect(store.snapshot()).toMatchObject({ height: 300, isOpen: true });
    expect(announced).toEqual([{ height: 300, durationMs: 250, measurement: 'hint' }]);
    store.handleNativeEvent('willHide', { durationMs: 200 });
    expect(store.snapshot()).toMatchObject({ height: 0, isOpen: false });
    expect(hidden).toBe(1);
    store.dispose();
  });

  it('accepts legacy willShow/didShow names from older native builds', () => {
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const targets: Array<{ height: number; measurement: string }> = [];
    store.onTargetChange((event) => {
      targets.push(event);
    });
    store.handleNativeEvent('willShow', {
      height: 320,
      durationMs: 250,
      measurement: 'exact',
    });
    expect(store.snapshot()).toMatchObject({ height: 320, isOpen: true });
    expect(targets).toEqual([
      { height: 320, durationMs: 250, measurement: 'exact' },
    ]);
    store.dispose();
  });

  it('ignores malformed payloads without collapsing layout', () => {
    const store = new KeyboardInsetStore();
    const seen = snapshots(store);
    store.handleNativeEvent('target', { height: 300, durationMs: 250 });
    const before = store.snapshot();
    store.handleNativeEvent('target', { height: 'tall' });
    store.handleNativeEvent('target', null);
    store.handleNativeEvent('settled', { height: Number.NaN });
    store.handleNativeEvent('change', { height: -5 });
    store.handleNativeEvent('bogus-event', { height: 10 });
    expect(store.snapshot()).toEqual(before);
    expect(seen.at(-1)).toEqual(before);
    store.dispose();
  });

  it('never exposes height 0 with isOpen true', () => {
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const targets: unknown[] = [];
    const settled: number[] = [];
    store.onTargetChange((event) => {
      targets.push(event);
    });
    store.onSettled((height) => {
      settled.push(height);
    });
    // Closed store stays closed on a zero target; no target announces.
    store.handleNativeEvent('target', { height: 0, durationMs: 0 });
    expect(store.snapshot()).toEqual({
      height: 0,
      isOpen: false,
      reservedHeight: KEYBOARD_INSET_FALLBACK_HEIGHT,
    });
    expect(targets).toEqual([]);
    // A zero settled report normalizes to closed, never to open-at-zero.
    store.handleNativeEvent('settled', { height: 0 });
    expect(store.snapshot()).toMatchObject({ height: 0, isOpen: false });
    // An open store hit by a malformed zero target keeps coherent state:
    // still open at the previous height, never height 0 + isOpen true.
    store.handleNativeEvent('target', {
      height: 300,
      durationMs: 250,
      measurement: 'exact',
    });
    store.handleNativeEvent('target', { height: 0, durationMs: 0 });
    expect(store.snapshot()).toMatchObject({ height: 300, isOpen: true });
    expect(targets).toHaveLength(1);
    // The proper close sequence still works.
    store.handleNativeEvent('willHide', { durationMs: 200 });
    store.handleNativeEvent('didHide', {});
    expect(store.snapshot()).toMatchObject({ height: 0, isOpen: false });
    expect(settled).toEqual([]);
    store.dispose();
  });

  it('adopts only settled heights as the reserved height (debounced)', async () => {
    vi.useFakeTimers();
    try {
      const storage = new Map<string, string>();
      const store = new KeyboardInsetStore({
        storage: {
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => {
            storage.set(key, value);
          },
        },
        settleDebounceMs: 120,
      });
      const settled: number[] = [];
      store.onSettled((height) => {
        settled.push(height);
      });
      // target overshoots; the reservation must not move yet.
      store.handleNativeEvent('target', { height: 334, durationMs: 250 });
      expect(store.snapshot().reservedHeight).toBe(
        KEYBOARD_INSET_FALLBACK_HEIGHT,
      );
      // Settled at the real height.
      store.handleNativeEvent('settled', { height: 300 });
      expect(settled).toEqual([]);
      await vi.advanceTimersByTimeAsync(120);
      expect(settled).toEqual([300]);
      expect(store.snapshot().reservedHeight).toBe(300);
      expect(storage.get(KEYBOARD_INSET_STORAGE_KEY)).toBe('300');
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops gap reports superseded by an animation (keyboard swap)', async () => {
    vi.useFakeTimers();
    try {
      const store = new KeyboardInsetStore({ settleDebounceMs: 120 });
      const settled: number[] = [];
      store.onSettled((height) => {
        settled.push(height);
      });
      store.handleNativeEvent('settled', { height: 300 });
      await vi.advanceTimersByTimeAsync(120);
      expect(settled).toEqual([300]);
      // A reopen lands between hide/show animations: the gap `change`
      // carries the animation hint and must not poison the reservation —
      // and, as a hint, it announces no new target either.
      const targets: number[] = [];
      store.onTargetChange((event) => {
        targets.push(event.height);
      });
      store.handleNativeEvent('change', { height: 120 });
      store.handleNativeEvent('target', { height: 300, durationMs: 250 });
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toEqual([300]);
      expect(targets).toEqual([300]);
      expect(store.snapshot().reservedHeight).toBe(300);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the persisted reservation and tolerates storage failure', () => {
    const storage = new Map<string, string>([
      [KEYBOARD_INSET_STORAGE_KEY, '310'],
    ]);
    const store = new KeyboardInsetStore({
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
      settleDebounceMs: 0,
    });
    expect(store.snapshot().reservedHeight).toBe(310);
    store.dispose();
  });

  it('trusts exact iOS geometry over settled history', () => {
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const announced: Array<{ height: number; measurement: string }> = [];
    store.onTargetChange((event) => {
      announced.push(event);
    });
    // Settle a portrait height first.
    store.handleNativeEvent('target', { height: 320, durationMs: 250 });
    store.handleNativeEvent('settled', { height: 320 });
    // Exact 346 with previous settled 320 → 346 immediately (no reconcile).
    store.handleNativeEvent('willHide', { durationMs: 200 });
    store.handleNativeEvent('didHide', {});
    store.handleNativeEvent('target', {
      height: 346,
      durationMs: 250,
      measurement: 'exact',
    });
    expect(store.snapshot()).toMatchObject({ height: 346, isOpen: true });
    expect(announced.at(-1)).toMatchObject({ height: 346, measurement: 'exact' });
    store.dispose();
  });

  it('reconciles hint geometry against settled history', () => {
    const storage = new Map<string, string>([
      [KEYBOARD_INSET_STORAGE_KEY, '320'],
    ]);
    const store = new KeyboardInsetStore({
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
      },
      settleDebounceMs: 0,
    });
    expect(store.snapshot().reservedHeight).toBe(320);
    // Hint 346 within 60px of settled 320 → reconciliation chooses 320.
    store.handleNativeEvent('target', { height: 346, durationMs: 250 });
    expect(store.snapshot()).toMatchObject({ height: 320, isOpen: true });
    store.dispose();
  });

  it('applies mid-session exact targets immediately with no zero reset', async () => {
    vi.useFakeTimers();
    try {
      const store = new KeyboardInsetStore({ settleDebounceMs: 120 });
      const targets: number[] = [];
      const seen: number[] = [];
      store.onTargetChange((event) => {
        targets.push(event.height);
      });
      store.subscribe((snapshot) => {
        seen.push(snapshot.height);
      });
      // Production sequence: appear, settle, resize, settle. Mid-session
      // resizes arrive as targets (the native adapter normalizes UIKit
      // notifications), never as a second appearance.
      store.handleNativeEvent('target', {
        height: 300,
        durationMs: 250,
        measurement: 'exact',
      });
      store.handleNativeEvent('settled', { height: 300 });
      store.handleNativeEvent('target', {
        height: 350,
        durationMs: 250,
        measurement: 'exact',
      });
      // The new target is announced synchronously — no debounce wait, no
      // intermediate zero — while the settled report still debounces.
      expect(targets).toEqual([300, 350]);
      expect(store.snapshot()).toMatchObject({ height: 350, isOpen: true });
      expect(seen).not.toContain(0);
      store.handleNativeEvent('settled', { height: 350 });
      await vi.advanceTimersByTimeAsync(120);
      expect(store.snapshot().reservedHeight).toBe(350);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exact orientation-changed targets never reuse the old orientation value', () => {
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    // Portrait settles at 346.
    store.handleNativeEvent('target', {
      height: 346,
      durationMs: 250,
      measurement: 'exact',
    });
    store.handleNativeEvent('settled', { height: 346, measurement: 'exact' });
    store.handleNativeEvent('willHide', { durationMs: 200 });
    store.handleNativeEvent('didHide', {});
    // Rotate → new exact landscape target wins immediately.
    store.handleNativeEvent('target', {
      height: 180,
      durationMs: 250,
      measurement: 'exact',
    });
    expect(store.snapshot()).toMatchObject({ height: 180, isOpen: true });
    store.dispose();
  });

  it('treats missing/unknown measurements as hint (backwards compatible)', () => {
    expect(readKeyboardInsetMeasurement({})).toBe('hint');
    expect(readKeyboardInsetMeasurement(null)).toBe('hint');
    expect(readKeyboardInsetMeasurement({ measurement: 'exact' })).toBe('exact');
    expect(readKeyboardInsetMeasurement({ measurement: 'EXACT' })).toBe('hint');
    expect(readKeyboardInsetMeasurement({ measurement: 'bogus' })).toBe('hint');
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const announced: Array<{ measurement: string }> = [];
    store.onTargetChange((event) => {
      announced.push(event);
    });
    store.handleNativeEvent('target', { height: 300, durationMs: 250 });
    expect(announced.at(-1)).toMatchObject({ measurement: 'hint' });
    store.dispose();
  });

  it('hide is a no-op while closed so caret focus never drops needlessly', () => {
    let calls = 0;
    const store = new KeyboardInsetStore({
      transport: {
        hide: () => {
          calls += 1;
        },
        show: () => undefined,
      },
    });
    store.hide();
    expect(calls).toBe(0);
    store.handleNativeEvent('target', { height: 300, durationMs: 250 });
    store.hide();
    expect(calls).toBe(1);
    store.dispose();
  });
});

describe('keyboard-inset fiber lifecycle', () => {
  it('binding follows activate → one, dispose → zero, reactivate → one', async () => {
    const runtime = new Runtime();
    const host = createKeyboardInset();
    const slot = await runtime.registerSlot({
      id: 'keyboard-inset',
      plugin: host.definition,
    });
    expect(runtime).toBeDefined();
    expect(slot.id).toBe('keyboard-inset');

    // The binding is observable through a dependent fiber.
    let observed = 0;
    const probe = await runtime.registerSlot({
      id: 'keyboard-inset-probe',
      plugin: definePlugin({
        id: 'froglight.keyboard-inset.probe',
        requirements: { requires: [keyboardInsetToken] },
        activate: (ctx) => {
          const service = ctx.require(keyboardInsetToken);
          observed = service.snapshot().reservedHeight;
          ctx.effect(() => () => {
            observed = 0;
          });
        },
      }),
    });
    expect(observed).toBe(KEYBOARD_INSET_FALLBACK_HEIGHT);

    await runtime.removeSlot(probe.id);
    expect(observed).toBe(0);

    await runtime.removeSlot(slot.id);
    // Reactivate → exactly one binding again, same host store retained.
    await runtime.registerSlot({
      id: 'keyboard-inset',
      plugin: host.definition,
    });
    let observedAgain = 0;
    await runtime.registerSlot({
      id: 'keyboard-inset-probe',
      plugin: definePlugin({
        id: 'froglight.keyboard-inset.probe',
        requirements: { requires: [keyboardInsetToken] },
        activate: (ctx) => {
          observedAgain = ctx
            .require(keyboardInsetToken)
            .snapshot().reservedHeight;
        },
      }),
    });
    expect(observedAgain).toBe(KEYBOARD_INSET_FALLBACK_HEIGHT);

    await runtime.dispose();
    host.store.dispose();
  });
});
