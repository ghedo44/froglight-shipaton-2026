/**
 * Deterministic ink sample fixtures (writing-experience upgrade, slice 1/2
 * instrumentation baseline): plain sample arrays covering handwriting
 * shapes, pressure/tilt variation, long strokes, dense batches, and
 * predicted tails. No randomness, no binary blobs — every stream rebuilds
 * identically on every run.
 */

import type { InkSample } from '../model.js';

function sample(
  x: number,
  y: number,
  extra: Partial<InkSample> = {},
): InkSample {
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    x: round(x),
    y: round(y),
    ...(extra.pressure !== undefined
      ? { pressure: round(extra.pressure) }
      : {}),
    ...(extra.tilt !== undefined
      ? { tilt: { x: round(extra.tilt.x), y: round(extra.tilt.y) } }
      : {}),
    ...(extra.twist !== undefined ? { twist: round(extra.twist) } : {}),
    ...(extra.dt !== undefined ? { dt: round(extra.dt) } : {}),
  };
}

/** Slow handwriting curve: dense, gentle sine with steady pressure. */
export function slowHandwritingCurve(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < 60; i++) {
    out.push(
      sample(i * 2, 50 + Math.sin(i / 6) * 12, {
        pressure: 0.5 + Math.sin(i / 9) * 0.05,
        dt: i * 8,
      }),
    );
  }
  return out;
}

/** Fast diagonal: sparse long segments with short timestamps. */
export function fastDiagonal(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < 12; i++) {
    out.push(sample(i * 20, i * 14, { pressure: 0.6, dt: i * 4 }));
  }
  return out;
}

/** Small handwritten loop: one closed circle, steady timing. */
export function smallLoop(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i <= 40; i++) {
    const angle = (i / 40) * Math.PI * 2;
    out.push(
      sample(30 + Math.cos(angle) * 18, 30 + Math.sin(angle) * 18, {
        pressure: 0.55,
        dt: i * 6,
      }),
    );
  }
  return out;
}

/** Sharp corner: horizontal run into a vertical run. */
export function sharpCorner(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i <= 20; i++) {
    out.push(sample(i * 5, 0, { pressure: 0.5, dt: i * 8 }));
  }
  for (let i = 1; i <= 20; i++) {
    out.push(sample(100, i * 5, { pressure: 0.5, dt: 160 + i * 8 }));
  }
  return out;
}

/** Pressure ramp: straight line, pressure 0.1 → 1. */
export function pressureRamp(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < 40; i++) {
    out.push(sample(i * 4, 10, { pressure: 0.1 + (i / 39) * 0.9, dt: i * 8 }));
  }
  return out;
}

/** Pressure oscillation: steady line, sinusoidal pressure. */
export function pressureOscillation(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < 80; i++) {
    out.push(
      sample(i * 2, 20, { pressure: 0.5 + Math.sin(i / 5) * 0.4, dt: i * 8 }),
    );
  }
  return out;
}

/** Tilt variation: steady line, tilt sweeping across both axes. */
export function tiltVariation(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < 50; i++) {
    out.push(
      sample(i * 3, 40, {
        pressure: 0.5,
        tilt: { x: Math.sin(i / 8) * 0.6, y: Math.cos(i / 8) * 0.4 },
        dt: i * 8,
      }),
    );
  }
  return out;
}

/** Long stroke: 1200+ samples of winding handwriting-like motion. */
export function longStroke(count = 1200): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      sample(
        (i % 60) * 4 + Math.sin(i / 11) * 6,
        Math.floor(i / 60) * 24 + Math.cos(i / 7) * 8,
        { pressure: 0.45 + (Math.sin(i / 13) * 0.5 + 0.5) * 0.3, dt: i * 8 },
      ),
    );
  }
  return out;
}

/** Dense coalesced batch: many samples inside a few surface units. */
export function denseBatch(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < 48; i++) {
    out.push(
      sample(100 + i * 0.3, 100 + Math.sin(i / 3) * 0.8, {
        pressure: 0.5,
        dt: i,
      }),
    );
  }
  return out;
}

/** Predicted-event tail: short continuation past a stroke end. */
export function predictedTail(): InkSample[] {
  return [
    sample(164, 52, { pressure: 0.5, dt: 328 }),
    sample(168, 53, { pressure: 0.48, dt: 336 }),
    sample(172, 55, { pressure: 0.45, dt: 344 }),
  ];
}

/** S-curve: two opposing arcs, steady pressure and timing. */
export function sCurve(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    out.push(
      sample(t * 120, 40 + Math.sin(t * Math.PI * 2) * 22, {
        pressure: 0.55,
        dt: i * 8,
      }),
    );
  }
  return out;
}

/** Large circle: closed loop, radius ~60, steady timing. */
export function bigCircle(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i <= 80; i++) {
    const angle = (i / 80) * Math.PI * 2;
    out.push(
      sample(100 + Math.cos(angle) * 60, 100 + Math.sin(angle) * 60, {
        pressure: 0.55,
        dt: i * 6,
      }),
    );
  }
  return out;
}

/** Spiral: three inward turns, steady pressure and timing. */
export function spiral(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    const angle = t * Math.PI * 6;
    const radius = 60 * (1 - t * 0.85);
    out.push(
      sample(100 + Math.cos(angle) * radius, 100 + Math.sin(angle) * radius, {
        pressure: 0.5,
        dt: i * 6,
      }),
    );
  }
  return out;
}

/** Small lowercase-style loops: an `e`-like chain of tight loops. */
export function smallLoops(): InkSample[] {
  const out: InkSample[] = [];
  let dt = 0;
  for (let loop = 0; loop < 4; loop++) {
    const cx = 20 + loop * 26;
    for (let i = 0; i <= 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      out.push(
        sample(cx + Math.cos(angle) * 7, 40 + Math.sin(angle) * 9, {
          pressure: 0.5,
          dt,
        }),
      );
      dt += 6;
    }
  }
  return out;
}

/** Slow diagonal: dense 45° handwriting-like motion with pressure. */
export function slowDiagonal(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < 80; i++) {
    out.push(
      sample(i * 2.5, i * 2.5 + Math.sin(i / 7) * 3, {
        pressure: 0.5 + Math.sin(i / 11) * 0.08,
        dt: i * 8,
      }),
    );
  }
  return out;
}

/** Tilt ramp: straight line, tilt sweeping 0 → near-full on both axes. */
export function tiltRamp(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < 40; i++) {
    const t = i / 39;
    out.push(
      sample(i * 4, 10, {
        pressure: 0.5,
        tilt: { x: t * 1.2, y: t * 0.9 },
        dt: i * 8,
      }),
    );
  }
  return out;
}

/** Long continuous handwriting: multi-line winding motion with pressure. */
export function longHandwriting(count = 2400): InkSample[] {
  return longStroke(count);
}

/** Named strokes of the developer handwriting geometry sheet: straight,
 *  shallow wave, S-curves, loops, humps, digits, a sentence, circles, a
 *  spiral, diagonals, and pressure/tilt ramps. A validation (not
 *  canonical persisted) fixture: every brush family renders the same
 *  sheet for inspection at 1×/2×/4×/8×/MAX_ZOOM. */
export function handwritingSheet(): { name: string; samples: InkSample[] }[] {
  const digits: InkSample[] = [];
  for (let d = 0; d < 10; d++) {
    for (let i = 0; i <= 12; i++) {
      digits.push(
        sample(
          d * 22 + Math.sin((i / 12) * Math.PI * 2 + d) * 6,
          (i / 12) * 24,
          {
            pressure: 0.5,
            dt: (d * 13 + i) * 8,
          },
        ),
      );
    }
  }
  const straight: InkSample[] = [];
  for (let i = 0; i <= 40; i++) {
    straight.push(sample(i * 5, 0, { pressure: 0.5, dt: i * 8 }));
  }
  return [
    { name: 'straight', samples: straight },
    { name: 'shallow-wave', samples: slowHandwritingCurve() },
    { name: 's-curve', samples: sCurve() },
    { name: 'loops', samples: smallLoops() },
    { name: 'small-loop', samples: smallLoop() },
    { name: 'large-circle', samples: bigCircle() },
    { name: 'spiral', samples: spiral() },
    { name: 'digits', samples: digits },
    { name: 'fast-diagonal', samples: fastDiagonal() },
    { name: 'slow-diagonal', samples: slowDiagonal() },
    { name: 'sharp-corner', samples: sharpCorner() },
    { name: 'pressure-ramp', samples: pressureRamp() },
    { name: 'tilt-ramp', samples: tiltRamp() },
    { name: 'long-handwriting', samples: longHandwriting(600) },
  ];
}
