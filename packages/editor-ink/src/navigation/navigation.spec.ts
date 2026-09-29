// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  NAVIGATION_PHYSICS,
  VelocityTracker,
  cancelMotion,
  elasticZoom,
  inverseRubberBand,
  primaryTouchPair,
  rubberBand,
  startSpringMotion,
  stepDecay,
  stepMotion,
  stepSpring,
} from './index.js';

describe('rubberBand', () => {
  it('is signed, monotonic, sub-linear, and zero at rest', () => {
    expect(rubberBand(0)).toBe(0);
    const near = rubberBand(40);
    const far = rubberBand(400);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    expect(far / 400).toBeLessThan(near / 40);
    expect(rubberBand(-40)).toBeCloseTo(-near, 12);
    expect(Math.abs(rubberBand(1e9))).toBeLessThanOrEqual(
      NAVIGATION_PHYSICS.rubberBandExtentPx,
    );
  });

  it('fails safely for invalid input', () => {
    expect(rubberBand(Number.NaN)).toBe(0);
    expect(rubberBand(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('elasticZoom', () => {
  it('keeps settled zoom legal while allowing bounded visual overzoom', () => {
    const above = elasticZoom(16, 0.25, 8);
    expect(above.rawZoom).toBe(16);
    expect(above.visualZoom).toBeGreaterThan(8);
    expect(above.visualZoom).toBeLessThan(16);
    expect(above.settledZoom).toBe(8);

    const below = elasticZoom(0.125, 0.25, 8);
    expect(below.visualZoom).toBeLessThan(0.25);
    expect(below.visualZoom).toBeGreaterThan(0.125);
    expect(below.settledZoom).toBe(0.25);
  });

  it('is symmetric for reciprocal excess in logarithmic zoom space', () => {
    const upper = elasticZoom(16, 0.25, 8).visualZoom / 8;
    const lower = 0.25 / elasticZoom(0.125, 0.25, 8).visualZoom;
    expect(upper).toBeCloseTo(lower, 12);
  });

  it('returns finite legal values for invalid input', () => {
    for (const raw of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const result = elasticZoom(raw, 0.25, 8);
      expect(Number.isFinite(result.rawZoom)).toBe(true);
      expect(Number.isFinite(result.visualZoom)).toBe(true);
      expect(result.settledZoom).toBeGreaterThanOrEqual(0.25);
      expect(result.settledZoom).toBeLessThanOrEqual(8);
    }
  });
});

describe('VelocityTracker', () => {
  it('uses a bounded recent monotonic sample window instead of the last pair', () => {
    const tracker = new VelocityTracker({ windowMs: 80, maxSamples: 5 });
    tracker.add(0, { x: 0, y: 0 });
    tracker.add(10, { x: 100, y: 0 });
    tracker.add(10, { x: 999, y: 999 }); // zero-duration: ignored
    for (let time = 100; time <= 160; time += 10)
      tracker.add(time, {
        x: (time - 100) / 10,
        y: (time - 100) / 5,
      });

    expect(tracker.sampleCount).toBeLessThanOrEqual(5);
    expect(tracker.velocity().x).toBeCloseTo(0.1, 9);
    expect(tracker.velocity().y).toBeCloseTo(0.2, 9);
  });

  it('ignores non-finite and non-monotonic samples', () => {
    const tracker = new VelocityTracker();
    tracker.add(10, { x: 0, y: 0 });
    tracker.add(5, { x: 100, y: 100 });
    tracker.add(Number.NaN, { x: 100, y: 100 });
    tracker.add(20, { x: Number.NaN, y: 0 });
    expect(tracker.sampleCount).toBe(1);
    expect(tracker.velocity()).toEqual({ x: 0, y: 0 });
  });

  it('returns finite velocity when finite samples overflow the estimator', () => {
    const tracker = new VelocityTracker();
    tracker.add(0, { x: -Number.MAX_VALUE, y: Number.MAX_VALUE });
    tracker.add(1, { x: Number.MAX_VALUE, y: -Number.MAX_VALUE });

    const velocity = tracker.velocity();
    expect(Number.isFinite(velocity.x)).toBe(true);
    expect(Number.isFinite(velocity.y)).toBe(true);
  });

  it('prunes stale movement at release and samples the held position', () => {
    const tracker = new VelocityTracker({ windowMs: 80 });
    tracker.add(0, { x: 0, y: 0 });
    tracker.add(20, { x: 100, y: 0 });

    expect(tracker.velocityAt(120, { x: 100, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('time-based motion', () => {
  function simulateDecay(frameMs: number) {
    let velocity = { x: 1, y: -0.5 };
    let position = { x: 0, y: 0 };
    for (let elapsed = 0; elapsed < 1000; elapsed += frameMs) {
      const dt = Math.min(frameMs, 1000 - elapsed);
      const next = stepDecay(velocity, dt);
      position = {
        x: position.x + next.displacement.x,
        y: position.y + next.displacement.y,
      };
      velocity = next.velocity;
    }
    return { position, velocity };
  }

  it('produces materially equivalent decay at 60 Hz and 120 Hz', () => {
    const sixty = simulateDecay(1000 / 60);
    const oneTwenty = simulateDecay(1000 / 120);
    expect(sixty.position.x).toBeCloseTo(oneTwenty.position.x, 6);
    expect(sixty.position.y).toBeCloseTo(oneTwenty.position.y, 6);
    expect(sixty.velocity.x).toBeCloseTo(oneTwenty.velocity.x, 9);
  });

  it('converges a non-oscillating spring and remains stable for large dt', () => {
    let state = { value: 100, velocity: 0 };
    let previousDistance = 100;
    for (let i = 0; i < 120; i++) {
      const next = stepSpring(state.value, state.velocity, 0, 1000 / 60);
      const distance = Math.abs(next.value);
      expect(distance).toBeLessThanOrEqual(previousDistance + 1e-9);
      expect(next.value).toBeGreaterThanOrEqual(0);
      previousDistance = distance;
      state = next;
    }
    expect(state.value).toBeCloseTo(0, 3);

    const largeStep = stepSpring(100, 200, 0, 10_000);
    expect(Number.isFinite(largeStep.value)).toBe(true);
    expect(Number.isFinite(largeStep.velocity)).toBe(true);
    expect(Math.abs(largeStep.value)).toBeLessThanOrEqual(100);
  });

  it('cancels at the current value and settles immediately for reduced motion', () => {
    const active = startSpringMotion(20, 0, 5, false);
    expect(stepMotion(active, 16).kind).toBe('spring');
    expect(cancelMotion(active)).toEqual({ kind: 'idle', value: 20 });
    expect(startSpringMotion(20, 0, 5, true)).toEqual({
      kind: 'idle',
      value: 0,
    });
  });

  it('composes tracked px/ms velocity through decay and an edge spring', () => {
    const tracker = new VelocityTracker();
    tracker.add(0, { x: 0, y: 0 });
    tracker.add(10, { x: 10, y: 0 });
    tracker.add(20, { x: 20, y: 0 });

    const decayed = stepDecay(tracker.velocity(), 10);
    expect(decayed.displacement.x).toBeGreaterThan(9);
    expect(decayed.velocity.x).toBeGreaterThan(0.9);
    expect(decayed.velocity.x).toBeLessThan(1);

    const edge = startSpringMotion(0, 0, decayed.velocity.x);
    expect(edge.kind).toBe('spring');
    const advanced = stepMotion(edge, 1);
    expect(advanced.kind).toBe('spring');
    expect(advanced.value).toBeGreaterThan(0.9);

    let settling = advanced;
    for (let frame = 0; frame < 120; frame += 1) {
      settling = stepMotion(settling, 1000 / 60);
    }
    expect(settling).toEqual({ kind: 'idle', value: 0 });
  });

  it('sanitizes every numeric field from a constructible invalid motion state', () => {
    const invalid = {
      kind: 'spring',
      value: Number.NaN,
      velocity: Number.POSITIVE_INFINITY,
      target: Number.NaN,
    } as const;

    const next = stepMotion(invalid, 16);
    expect(Number.isFinite(next.value)).toBe(true);
    if (next.kind === 'spring') {
      expect(Number.isFinite(next.velocity)).toBe(true);
      expect(Number.isFinite(next.target)).toBe(true);
    }
  });
});

describe('inverseRubberBand', () => {
  const extent = NAVIGATION_PHYSICS.rubberBandExtentPx;
  const coefficient = NAVIGATION_PHYSICS.rubberBandCoefficient;

  it('round-trips rubberBand excess across representative values', () => {
    const excesses = [1, 10, 40, 80, 120, 200, 400, 1000, 10_000];
    for (const excess of [...excesses, ...excesses.map((value) => -value)]) {
      const visual = rubberBand(excess);
      // Visual output must stay strictly inside the asymptote.
      expect(Math.abs(visual)).toBeLessThan(extent);
      const restored = inverseRubberBand(visual);
      const tolerance = Math.max(1e-9, Math.abs(excess) * 1e-9);
      expect(Math.abs(restored - excess)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('is zero at rest and sign-symmetric', () => {
    expect(inverseRubberBand(0)).toBe(0);
    expect(inverseRubberBand(-0)).toBe(0);
    expect(inverseRubberBand(rubberBand(0))).toBe(0);
    const visual = rubberBand(40);
    expect(inverseRubberBand(-visual)).toBeCloseTo(
      -inverseRubberBand(visual),
      12,
    );
    expect(Math.sign(inverseRubberBand(visual))).toBe(1);
    expect(Math.sign(inverseRubberBand(-visual))).toBe(-1);
  });

  it('is monotonic over the invertible range', () => {
    const visuals = [0, 5, 20, 40, 60, 80, 100, extent * 0.99];
    let previous = -Infinity;
    for (const visual of visuals) {
      const restored = inverseRubberBand(visual);
      expect(restored).toBeGreaterThan(previous);
      previous = restored;
    }
    let previousNegative = Infinity;
    for (const visual of visuals) {
      const restored = inverseRubberBand(-visual);
      expect(restored).toBeLessThan(previousNegative);
      previousNegative = restored;
    }
  });

  it('passes through magnitudes at or above the asymptote unchanged', () => {
    expect(inverseRubberBand(extent)).toBe(extent);
    expect(inverseRubberBand(-extent)).toBe(-extent);
    expect(inverseRubberBand(extent + 10)).toBe(extent + 10);
    expect(inverseRubberBand(-extent - 10)).toBe(-extent - 10);
    expect(inverseRubberBand(extent * 2)).toBe(extent * 2);
  });

  it('grows without bound but stays finite approaching the asymptote', () => {
    const near = inverseRubberBand(extent * 0.99);
    const nearer = inverseRubberBand(extent * 0.999);
    expect(Number.isFinite(near)).toBe(true);
    expect(Number.isFinite(nearer)).toBe(true);
    expect(nearer).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(extent);
    // Algebraic form: (r * E) / (c * (E - r)).
    const expected = ((extent * 0.5 * extent) / (coefficient * (extent * 0.5)));
    expect(inverseRubberBand(extent * 0.5)).toBeCloseTo(expected, 9);
  });

  it('fails safely for non-finite input or extent', () => {
    expect(inverseRubberBand(Number.NaN)).toBe(0);
    expect(inverseRubberBand(Number.POSITIVE_INFINITY)).toBe(0);
    expect(inverseRubberBand(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(inverseRubberBand(10, Number.NaN)).toBe(0);
    expect(inverseRubberBand(10, Number.POSITIVE_INFINITY)).toBe(0);
    expect(inverseRubberBand(10, 0)).toBe(0);
    expect(inverseRubberBand(10, -5)).toBe(0);
    expect(inverseRubberBand(Number.NaN, Number.NaN)).toBe(0);
  });

  it('round-trips with a custom extent', () => {
    const customExtent = 50;
    for (const excess of [5, 25, 100, 500, -75, -1000]) {
      const visual = rubberBand(excess, customExtent);
      expect(Math.abs(visual)).toBeLessThan(customExtent);
      const restored = inverseRubberBand(visual, customExtent);
      const tolerance = Math.max(1e-9, Math.abs(excess) * 1e-9);
      expect(Math.abs(restored - excess)).toBeLessThanOrEqual(tolerance);
    }
    expect(inverseRubberBand(customExtent, customExtent)).toBe(customExtent);
  });
});

describe('physics dt edge cases', () => {
  it('holds decay velocity and emits zero displacement for empty/invalid dt', () => {
    const velocity = { x: 1, y: -0.5 };
    for (const dt of [0, -1, -16, Number.NaN, Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY]) {
      const next = stepDecay(velocity, dt);
      expect(next.displacement).toEqual({ x: 0, y: 0 });
      expect(next.velocity).toEqual(velocity);
      expect(next.active).toBe(true);
    }
    const slow = stepDecay({ x: 0.001, y: 0 }, 0);
    expect(slow.displacement).toEqual({ x: 0, y: 0 });
    expect(slow.active).toBe(false);
  });

  it('holds spring value/velocity for empty/invalid dt', () => {
    for (const dt of [0, -16, Number.NaN, Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY]) {
      const held = stepSpring(100, 2, 0, dt);
      expect(held.value).toBe(100);
      expect(held.velocity).toBe(2);
      expect(held.active).toBe(true);
      const settled = stepSpring(0, 0, 0, dt);
      expect(settled).toEqual({ value: 0, velocity: 0, active: false });
    }
    const motionHeld = stepMotion(
      { kind: 'spring', value: 10, velocity: 1, target: 0 },
      Number.NaN,
    );
    expect(motionHeld).toEqual({
      kind: 'spring',
      value: 10,
      velocity: 1,
      target: 0,
    });
  });

  it('settles to finite output for a very large frame gap', () => {
    const decayed = stepDecay({ x: 2, y: -1 }, 10_000);
    expect(Number.isFinite(decayed.displacement.x)).toBe(true);
    expect(Number.isFinite(decayed.displacement.y)).toBe(true);
    expect(Number.isFinite(decayed.velocity.x)).toBe(true);
    expect(Number.isFinite(decayed.velocity.y)).toBe(true);
    expect(decayed.active).toBe(false);
    expect(Math.hypot(decayed.velocity.x, decayed.velocity.y)).toBeLessThan(
      NAVIGATION_PHYSICS.decayStopVelocityPxPerMs,
    );
    // Total decay distance from 2 px/ms is bounded by v * 1000 / rate.
    const bound = (2 * 1000) / NAVIGATION_PHYSICS.decayRatePerSecond;
    expect(Math.abs(decayed.displacement.x)).toBeLessThanOrEqual(bound + 1e-9);

    const sprung = stepSpring(100, 200, 0, 10_000);
    expect(Number.isFinite(sprung.value)).toBe(true);
    expect(Number.isFinite(sprung.velocity)).toBe(true);
    expect(sprung).toEqual({ value: 0, velocity: 0, active: false });
  });

  it('never emits NaN/Infinity velocity or displacement', () => {
    // Non-finite touch inputs sanitize to rest; large-but-realistic flings
    // (<= 100 px/ms, far above any touch tracker output) stay finite across
    // the dt range including the pager 64ms clamp and defensive large gaps.
    // Note: exact exponential integration can overflow displacement for
    // pathological Number.MAX_VALUE velocities; VelocityTracker already
    // clamps such overflow to finite moderate velocities before decay runs,
    // so that extreme is intentionally not asserted finite here.
    const decayInputs = [
      { x: Number.NaN, y: Number.NaN },
      { x: Number.POSITIVE_INFINITY, y: Number.NEGATIVE_INFINITY },
      { x: 100, y: -100 },
      { x: -50, y: 50 },
    ];
    for (const velocity of decayInputs) {
      for (const dt of [0, 16, 64, 1000]) {
        const next = stepDecay(velocity, dt);
        expect(Number.isFinite(next.displacement.x)).toBe(true);
        expect(Number.isFinite(next.displacement.y)).toBe(true);
        expect(Number.isFinite(next.velocity.x)).toBe(true);
        expect(Number.isFinite(next.velocity.y)).toBe(true);
      }
    }
    const springInputs: Array<[number, number, number]> = [
      [Number.NaN, Number.NaN, Number.NaN],
      [
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      ],
      [Number.MAX_VALUE, Number.MAX_VALUE, 0],
    ];
    for (const [value, velocity, target] of springInputs) {
      for (const dt of [0, 16, 64, 1000]) {
        const next = stepSpring(value, velocity, target, dt);
        expect(Number.isFinite(next.value)).toBe(true);
        expect(Number.isFinite(next.velocity)).toBe(true);
      }
    }
  });

  it('stays stable across the pager 64ms clamp and converges independent of cadence', () => {
    // Pager clamps per-frame deltas to [0, 64]ms
    // (stepPagerMotion: max(0, min(timestamp - motionTime, 64))). Physics must
    // be stable on (0, 64] per frame; larger gaps are covered defensively above.
    for (const dt of [1000 / 120, 1000 / 60, 33.333, 64]) {
      const decayed = stepDecay({ x: 1.5, y: 0.5 }, dt);
      expect(Number.isFinite(decayed.displacement.x)).toBe(true);
      expect(Number.isFinite(decayed.velocity.x)).toBe(true);
      const sprung = stepSpring(80, -1, 0, dt);
      expect(Number.isFinite(sprung.value)).toBe(true);
      expect(Number.isFinite(sprung.velocity)).toBe(true);
    }

    function settleSpring(frameMs: number) {
      let value = 80;
      let velocity = -1;
      for (let i = 0; i < 600; i++) {
        const next = stepSpring(value, velocity, 0, frameMs);
        value = next.value;
        velocity = next.velocity;
        expect(Number.isFinite(value)).toBe(true);
        expect(Number.isFinite(velocity)).toBe(true);
        if (!next.active) break;
      }
      return { value, velocity };
    }
    const sixty = settleSpring(1000 / 60);
    const oneTwenty = settleSpring(1000 / 120);
    expect(sixty.value).toBeCloseTo(0, 2);
    expect(oneTwenty.value).toBeCloseTo(0, 2);
    expect(Math.abs(sixty.value - oneTwenty.value)).toBeLessThan(0.05);
    expect(sixty.velocity).toBeCloseTo(0, 2);
    expect(oneTwenty.velocity).toBeCloseTo(0, 2);

    function settleDecay(frameMs: number) {
      let velocity = { x: 1.5, y: 0.5 };
      let position = { x: 0, y: 0 };
      for (let i = 0; i < 1200; i++) {
        const next = stepDecay(velocity, frameMs);
        expect(Number.isFinite(next.displacement.x)).toBe(true);
        expect(Number.isFinite(next.velocity.x)).toBe(true);
        position = {
          x: position.x + next.displacement.x,
          y: position.y + next.displacement.y,
        };
        velocity = next.velocity;
        if (!next.active) break;
      }
      return { position, velocity };
    }
    const decaySixty = settleDecay(1000 / 60);
    const decayOneTwenty = settleDecay(1000 / 120);
    expect(Math.hypot(decaySixty.velocity.x, decaySixty.velocity.y)).toBeLessThan(
      NAVIGATION_PHYSICS.decayStopVelocityPxPerMs + 1e-12,
    );
    expect(
      Math.hypot(decayOneTwenty.velocity.x, decayOneTwenty.velocity.y),
    ).toBeLessThan(NAVIGATION_PHYSICS.decayStopVelocityPxPerMs + 1e-12);
    expect(decaySixty.position.x).toBeCloseTo(decayOneTwenty.position.x, 0);
    expect(decaySixty.position.y).toBeCloseTo(decayOneTwenty.position.y, 0);
  });
});

describe('primaryTouchPair', () => {
  const contacts = [
    { id: 9, x: 90, y: 0 },
    { id: 2, x: 20, y: 0 },
    { id: 5, x: 50, y: 0 },
  ] as const;

  it('selects deterministically and ignores additional contact order', () => {
    expect(primaryTouchPair(contacts)?.map((contact) => contact.id)).toEqual([
      2, 5,
    ]);
    expect(
      primaryTouchPair([...contacts].reverse())?.map((contact) => contact.id),
    ).toEqual([2, 5]);
  });

  it('retains surviving primary contacts and fills a replacement deterministically', () => {
    const previous = [2, 5] as const;
    expect(primaryTouchPair(contacts, previous)?.map(({ id }) => id)).toEqual([
      2, 5,
    ]);
    const withoutTwo = contacts.filter(({ id }) => id !== 2);
    expect(primaryTouchPair(withoutTwo, previous)?.map(({ id }) => id)).toEqual(
      [5, 9],
    );
    expect(primaryTouchPair([{ id: 9, x: 90, y: 0 }], previous)).toBeNull();
  });
});
