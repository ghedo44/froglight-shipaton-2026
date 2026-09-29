/**
 * Input hardening: malformed browser events, non-finite axes, and twist
 * safety. Deterministic, no DOM layout — pure normalization only.
 */
import { describe, expect, it } from 'vitest';
import { normalizePointerAxes } from './pointer.js';
import {
  normalizeInkInputBatch,
  normalizeInkPointerEvent,
} from './ink-input.js';

describe('pointer axis safety', () => {
  it('drops non-finite pressure instead of clamping to 1', () => {
    const out = normalizePointerAxes(
      { x: 0, y: 0 },
      { pressure: Number.POSITIVE_INFINITY },
    );
    expect(out.pressure).toBeUndefined();
  });

  it('drops overflowing twist without hanging', () => {
    // 1e308° overflows to Infinity in radians: must drop (undefined),
    // never loop or produce NaN geometry. No hang is the assertion.
    const out = normalizePointerAxes({ x: 0, y: 0 }, { twist: 1e308 });
    expect(out.twist).toBeUndefined();
  });

  it('drops non-finite twist instead of hanging', () => {
    const out = normalizePointerAxes(
      { x: 0, y: 0 },
      { twist: Number.POSITIVE_INFINITY },
    );
    expect(out.twist).toBeUndefined();
  });
});

describe('ink input malformed events', () => {
  const rect = { left: 0, top: 0 };

  it('drops null holes in coalesced lists without throwing', () => {
    const event = {
      clientX: 10,
      clientY: 10,
      getCoalescedEvents: () => [null, { clientX: 10, clientY: 10 }],
      getPredictedEvents: () => [],
    } as never;
    expect(() => normalizeInkInputBatch(event, rect)).not.toThrow();
    const batch = normalizeInkInputBatch(event, rect);
    expect(batch.confirmed.length).toBeGreaterThan(0);
  });

  it('preserves Shift for additive selection', () => {
    expect(
      normalizeInkPointerEvent({ clientX: 5, clientY: 5, shiftKey: true }, rect)
        ?.shift,
    ).toBe(true);
    expect(
      normalizeInkPointerEvent(
        { clientX: 5, clientY: 5, shiftKey: false },
        rect,
      )?.shift,
    ).toBe(false);
  });

  it('returns null for non-finite down coords instead of stuck state', () => {
    const out = normalizeInkPointerEvent(
      { clientX: Number.NaN, clientY: 0 } as never,
      rect,
    );
    expect(out).toBeNull();
  });

  it('survives throwing event getters', () => {
    const event = {
      clientX: 5,
      clientY: 5,
      getCoalescedEvents: () => {
        throw new Error('browser quirk');
      },
      getPredictedEvents: () => {
        throw new Error('browser quirk');
      },
    } as never;
    const batch = normalizeInkInputBatch(event, rect);
    expect(batch.confirmed).toHaveLength(1);
    expect(batch.predicted).toHaveLength(0);
  });
});
