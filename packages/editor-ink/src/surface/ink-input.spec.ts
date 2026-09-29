/**
 * Ink input batch normalization (writing-experience upgrade, slice 1):
 * one DOM PointerEvent fans out to coalesced + predicted samples, all
 * normalized against a single canvas geometry read. Confirmed samples keep
 * temporal order with duplicates removed; predicted samples stay separate
 * and carry plain data only — DOM events are never retained.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeInkInputBatch,
  normalizeInkPointerUpBatch,
  type RawInkPointerEvent,
} from './ink-input.js';

const RECT = { left: 10, top: 20 };

function raw(
  clientX: number,
  clientY: number,
  extra: Partial<RawInkPointerEvent> = {},
): RawInkPointerEvent {
  return { clientX, clientY, timeStamp: 1000, ...extra };
}

function coalescedEvent(
  samples: RawInkPointerEvent[],
  current: RawInkPointerEvent,
  extra: Partial<RawInkPointerEvent> = {},
): RawInkPointerEvent {
  return {
    ...current,
    getCoalescedEvents: () => samples,
    ...extra,
  };
}

describe('normalizeInkInputBatch', () => {
  it('does not append a processed parent position across a coalesced curve', () => {
    const curve = [raw(20, 30), raw(30, 50), raw(50, 60), raw(70, 40)];
    const batch = normalizeInkInputBatch(coalescedEvent(curve, raw(20, 30, { pressure: 0.6 })), RECT);
    expect(batch.confirmed.map((sample) => sample.point)).toEqual([
      { x: 10, y: 10 }, { x: 20, y: 30 }, { x: 40, y: 40 }, { x: 60, y: 20 },
    ]);
  });

  it('uses coalesced events as the ordered confirmed batch', () => {
    const event = coalescedEvent(
      [raw(11, 21), raw(15, 25, { pressure: 0.5 }), raw(19, 29)],
      raw(19, 29),
    );
    const batch = normalizeInkInputBatch(event, RECT);
    expect(batch.confirmed.map((s) => s.point)).toEqual([
      { x: 1, y: 1 },
      { x: 5, y: 5 },
      { x: 9, y: 9 },
    ]);
    expect(batch.confirmed[1]!.pressure).toBe(0.5);
    expect(batch.predicted).toEqual([]);
  });

  it('falls back to the current event when coalesced is empty or missing', () => {
    const lone = raw(30, 40, { pressure: 0.7 });
    expect(normalizeInkInputBatch(lone, RECT).confirmed).toEqual([
      { point: { x: 20, y: 20 }, pressure: 0.7, time: 1000 },
    ]);
    const empty = coalescedEvent([], raw(30, 40));
    expect(
      normalizeInkInputBatch(empty, RECT).confirmed.map((s) => s.point),
    ).toEqual([{ x: 20, y: 20 }]);
  });

  it('removes consecutive duplicate samples, including the trailing current event', () => {
    const event = coalescedEvent(
      [raw(11, 21), raw(11, 21), raw(15, 25)],
      raw(15, 25),
    );
    const batch = normalizeInkInputBatch(event, RECT);
    expect(batch.confirmed.map((s) => s.point)).toEqual([
      { x: 1, y: 1 },
      { x: 5, y: 5 },
    ]);
  });

  it('keeps predicted events separate from confirmed samples', () => {
    const event = coalescedEvent([raw(11, 21), raw(15, 25)], raw(15, 25), {
      getPredictedEvents: () => [raw(19, 29), raw(23, 33)],
    });
    const batch = normalizeInkInputBatch(event, RECT);
    expect(batch.confirmed.map((s) => s.point)).toEqual([
      { x: 1, y: 1 },
      { x: 5, y: 5 },
    ]);
    expect(batch.predicted.map((s) => s.point)).toEqual([
      { x: 9, y: 9 },
      { x: 13, y: 13 },
    ]);
  });

  it('carries hardware axes and time per sample', () => {
    const event = raw(12, 24, {
      pressure: 0.4,
      tiltX: 10,
      tiltY: -5,
      twist: 90,
      timeStamp: 1234.5,
    });
    const batch = normalizeInkInputBatch(event, RECT);
    expect(batch.confirmed).toEqual([
      {
        point: { x: 2, y: 4 },
        pressure: 0.4,
        tilt: { x: (10 * Math.PI) / 180, y: (-5 * Math.PI) / 180 },
        twist: Math.PI / 2,
        time: 1234.5,
      },
    ]);
  });

  it('keeps zero-pressure contact and stationary pressure changes', () => {
    const event = coalescedEvent(
      [raw(15, 25, { pressure: 0.7, timeStamp: 10 }), raw(15, 25, { pressure: 0, timeStamp: 18 })],
      raw(15, 25, { pressure: 0, timeStamp: 18 }),
    );
    expect(normalizeInkInputBatch(event, RECT).confirmed).toEqual([
      { point: { x: 5, y: 5 }, pressure: 0.7, time: 10 },
      { point: { x: 5, y: 5 }, pressure: 0, time: 18 },
    ]);
  });

  it('omits time when the event timestamp is missing instead of inventing one', () => {
    const event: RawInkPointerEvent = { clientX: 11, clientY: 21 };
    const batch = normalizeInkInputBatch(event, RECT);
    expect(batch.confirmed).toEqual([{ point: { x: 1, y: 1 } }]);
    expect('time' in batch.confirmed[0]!).toBe(false);
  });

  it('returns plain data that never retains the DOM event', () => {
    const event = coalescedEvent([raw(11, 21)], raw(11, 21), {
      getPredictedEvents: () => [raw(15, 25)],
    });
    const batch = normalizeInkInputBatch(event, RECT);
    // JSON-serializable means no functions, no DOM nodes, no event refs.
    expect(JSON.parse(JSON.stringify(batch))).toEqual(batch);
    for (const sample of [...batch.confirmed, ...batch.predicted]) {
      expect(new Set(Object.keys(sample))).toEqual(
        new Set(
          ['point', 'pressure', 'tilt', 'twist', 'time'].filter(
            (key) => key in sample,
          ),
        ),
      );
    }
  });
});

describe('normalizeInkPointerUpBatch', () => {
  const previous = {
    point: { x: 5, y: 5 },
    pressure: 0.9,
    tilt: { x: 0.1, y: -0.2 },
    twist: 0.4,
    time: 10,
  };

  it('drops a stationary outer lift reset instead of narrowing the tip', () => {
    const event = raw(15, 25, { pressure: 0, timeStamp: 18 });
    expect(normalizeInkPointerUpBatch(event, RECT, previous).confirmed).toEqual(
      [],
    );
  });

  it('retains final coalesced contacts, including true zero pressure', () => {
    const event = coalescedEvent(
      [
        raw(17, 27, { pressure: 0.6, timeStamp: 14 }),
        raw(19, 29, { pressure: 0, timeStamp: 16 }),
      ],
      raw(19, 29, { pressure: 0, timeStamp: 18 }),
    );
    expect(normalizeInkPointerUpBatch(event, RECT, previous).confirmed).toEqual(
      [
        { point: { x: 7, y: 7 }, pressure: 0.6, time: 14 },
        { point: { x: 9, y: 9 }, pressure: 0, time: 16 },
      ],
    );
  });

  it('keeps a lift-only endpoint with the last contact axes', () => {
    const event = raw(20, 30, { pressure: 0, timeStamp: 18 });
    expect(normalizeInkPointerUpBatch(event, RECT, previous).confirmed).toEqual(
      [
        {
          point: { x: 10, y: 10 },
          pressure: 0.9,
          tilt: { x: 0.1, y: -0.2 },
          twist: 0.4,
          time: 18,
        },
      ],
    );
  });
});
