import { describe, expect, it } from 'vitest';
import type { InkSample } from '../model.js';
import { HIGHLIGHTER_BRUSH, BALL_PEN_BRUSH } from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  CORNER_EVIDENCE_SPACING,
  hasSourceCornerEvidence,
  sourceArcLength,
} from './corner-evidence.js';
import { sharpCorner } from './fixtures.js';
import { LiveInkStrokeCompiler } from './live-compiler.js';
import { arcLengthResample } from './resample.js';
import { sanitizeSamples } from './samples.js';

function smoothTightLoops(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i <= 240; i++) {
    const t = i / 240;
    out.push({
      x: (100 * t + 10 * Math.sin(6 * Math.PI * t)) / 0.88,
      y: (14 * Math.sin(8 * Math.PI * t)) / 0.88,
      pressure: 0.95,
      dt: i * 8,
    });
  }
  return out;
}

function vCorner(turnDegrees: number): InkSample[] {
  const turn = (turnDegrees * Math.PI) / 180;
  const out: InkSample[] = [];
  for (let i = 0; i <= 20; i++) {
    out.push({ x: i * 3, y: 0, pressure: 0.5, dt: i * 8 });
  }
  for (let i = 1; i <= 20; i++) {
    out.push({
      x: 60 + i * 3 * Math.cos(turn),
      y: i * 3 * Math.sin(turn),
      pressure: 0.5,
      dt: (20 + i) * 8,
    });
  }
  return out;
}

describe('dense source corner evidence', () => {
  it('rejects smooth tight curvature that aliases to coarse hard corners', () => {
    const samples = smoothTightLoops();
    const cleaned = sanitizeSamples(samples, 0);
    const source = arcLengthResample(cleaned, CORNER_EVIDENCE_SPACING);
    const total = sourceArcLength(cleaned);
    for (let i = 0; i < Math.ceil(total / 3); i++) {
      expect(hasSourceCornerEvidence(source, total, i, 3)).toBe(false);
    }

    const compiled = compileInkStroke(samples, HIGHLIGHTER_BRUSH);
    expect(compiled.curve.cornerCount).toBe(0);
    expect(compiled.nodes.some((node) => node.corner !== undefined)).toBe(
      false,
    );
    for (let i = 0; i < compiled.nodes.length; i++) {
      const node = compiled.nodes[i]!;
      expect(
        Math.hypot(
          compiled.mesh.left[i]!.x - node.x,
          compiled.mesh.left[i]!.y - node.y,
        ),
      ).toBeLessThan(7.1);
      expect(
        Math.hypot(
          compiled.mesh.right[i]!.x - node.x,
          compiled.mesh.right[i]!.y - node.y,
        ),
      ).toBeLessThan(7.1);
    }
  });

  it.each([
    ['L', sharpCorner()],
    ['acute V', vCorner(75)],
    ['obtuse V', vCorner(120)],
    ['near reversal', vCorner(170)],
  ])('retains an intentional %s corner', (_name, samples) => {
    const compiled = compileInkStroke(samples, BALL_PEN_BRUSH);
    expect(compiled.curve.cornerCount).toBe(1);
    expect(
      compiled.nodes.filter((node) => node.corner !== undefined),
    ).toHaveLength(1);
  });

  it('recognizes a 60-degree source turn when the coarse classifier asks', () => {
    const cleaned = sanitizeSamples(vCorner(60), 0);
    const source = arcLengthResample(cleaned, CORNER_EVIDENCE_SPACING);
    const total = sourceArcLength(cleaned);
    expect(
      Array.from({ length: Math.ceil(total / 1.05) }, (_, i) =>
        hasSourceCornerEvidence(source, total, i, 1.05),
      ).some(Boolean),
    ).toBe(true);
  });

  it('keeps full and live corner decisions invariant across batching', () => {
    const samples = smoothTightLoops();
    const full = compileInkStroke(samples, HIGHLIGHTER_BRUSH);
    for (const batchSize of [1, 7, samples.length]) {
      const live = new LiveInkStrokeCompiler();
      live.begin(samples[0]!, HIGHLIGHTER_BRUSH);
      for (let i = 1; i < samples.length; i += batchSize) {
        live.append(samples.slice(i, i + batchSize));
      }
      expect(live.geometry().curve.cornerCount).toBe(0);
      expect(live.finish().polygon).toEqual(full.polygon);
    }
  });

  it('uses the same dense evidence in an ephemeral predicted tail', () => {
    const samples = vCorner(90);
    const split = 18;
    const live = new LiveInkStrokeCompiler();
    live.begin(samples[0]!, BALL_PEN_BRUSH);
    live.append(samples.slice(1, split));
    const predicted = live.appendPredicted(samples.slice(split));

    const confirmed = new LiveInkStrokeCompiler();
    confirmed.begin(samples[0]!, BALL_PEN_BRUSH);
    confirmed.append(samples.slice(1));
    expect(predicted.nodes.some((node) => node.corner !== undefined)).toBe(
      true,
    );
    expect(
      confirmed.geometry().nodes.some((node) => node.corner !== undefined),
    ).toBe(true);
    expect(live.confirmedCount()).toBe(split);
  });
});
