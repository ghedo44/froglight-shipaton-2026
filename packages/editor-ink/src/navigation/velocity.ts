import type { Point } from '@froglight/foundation';
import { NAVIGATION_PHYSICS } from './config.js';

export interface VelocityTrackerOptions {
  readonly windowMs?: number;
  readonly maxSamples?: number;
}

interface VelocitySample {
  readonly timeMs: number;
  readonly point: Point;
}

/** Bounded recent-window least-squares velocity estimator in CSS px/ms. */
export class VelocityTracker {
  readonly #windowMs: number;
  readonly #maxSamples: number;
  readonly #samples: VelocitySample[] = [];

  constructor(options: VelocityTrackerOptions = {}) {
    const requestedWindow = options.windowMs;
    const requestedMaximum = options.maxSamples;
    this.#windowMs =
      typeof requestedWindow === 'number' &&
      Number.isFinite(requestedWindow) &&
      requestedWindow > 0
        ? requestedWindow
        : NAVIGATION_PHYSICS.velocityWindowMs;
    this.#maxSamples =
      typeof requestedMaximum === 'number' &&
      Number.isInteger(requestedMaximum) &&
      requestedMaximum >= 2
        ? requestedMaximum
        : NAVIGATION_PHYSICS.velocityMaxSamples;
  }

  get sampleCount(): number {
    return this.#samples.length;
  }

  reset(): void {
    this.#samples.length = 0;
  }

  add(timeMs: number, point: Point): void {
    if (
      !Number.isFinite(timeMs) ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    )
      return;
    const latest = this.#samples[this.#samples.length - 1];
    if (latest !== undefined && timeMs <= latest.timeMs) return;
    this.#samples.push({ timeMs, point: { ...point } });
    this.#prune(timeMs);
    while (this.#samples.length > this.#maxSamples) this.#samples.shift();
  }

  /**
   * Sample the release position and discard motion older than the velocity
   * window. This prevents a pause before lift from replaying a stale fling.
   */
  velocityAt(timeMs: number, point: Point): Point {
    if (
      Number.isFinite(timeMs) &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y)
    ) {
      this.add(timeMs, point);
      this.#prune(timeMs);
    }
    return this.velocity();
  }

  #prune(timeMs: number): void {
    const cutoff = timeMs - this.#windowMs;
    while ((this.#samples[0]?.timeMs ?? cutoff) < cutoff) this.#samples.shift();
  }

  velocity(): Point {
    if (this.#samples.length < 2) return { x: 0, y: 0 };
    const origin = this.#samples[0]?.timeMs ?? 0;
    let meanTime = 0;
    let meanX = 0;
    let meanY = 0;
    for (const sample of this.#samples) {
      meanTime += sample.timeMs - origin;
      meanX += sample.point.x;
      meanY += sample.point.y;
    }
    meanTime /= this.#samples.length;
    meanX /= this.#samples.length;
    meanY /= this.#samples.length;
    let variance = 0;
    let covarianceX = 0;
    let covarianceY = 0;
    for (const sample of this.#samples) {
      const time = sample.timeMs - origin - meanTime;
      variance += time * time;
      covarianceX += time * (sample.point.x - meanX);
      covarianceY += time * (sample.point.y - meanY);
    }
    if (variance <= 0 || !Number.isFinite(variance)) return { x: 0, y: 0 };
    const x = covarianceX / variance;
    const y = covarianceY / variance;
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    };
  }
}
