/**
 * Real-Chromium frozen-head Canvas strategy validation (item 4) plus
 * prediction-seam pixel safety (item 5).
 *
 * The headless counters prove bounded JS vertex work, but
 * `combined.addPath(headPath)` may still perform history-sized NATIVE work
 * inside Chromium. This spec measures real `Path2D.addPath + fill` frame
 * cost for 100 / 1k / 5k / 10k / 20k samples across straight strokes,
 * S-curves, and repetitive circles. If frame cost grew materially with
 * frozen history, the combined-Path2D strategy would have to be replaced
 * with retained/offscreen head layers — the budgets below pin the current
 * strategy.
 *
 * Seam pixel safety (item 5): head prefix + mutable tail in ONE fill must
 * show no gap, dark seam, light hairline, duplicate fill, or chord. Pixels
 * are read back via `getImageData` on a real canvas.
 */

import { expect, test } from '@playwright/test';

interface BenchPoint {
  sizes: number[];
  shapes: string[];
  mediansMs: Record<string, Record<string, number>>;
  p95Ms: Record<string, Record<string, number>>;
}

test('frozen-head addPath+fill stays flat with history (Chromium)', async ({
  page,
}) => {
  await page.goto('about:blank');
  const result = (await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';

    function shapeSamples(
      kind: string,
      count: number,
    ): Array<{ x: number; y: number }> {
      const out: Array<{ x: number; y: number }> = [];
      if (kind === 'straight') {
        for (let i = 0; i < count; i++) out.push({ x: i * 0.7, y: 300 });
      } else if (kind === 's-curve') {
        for (let i = 0; i < count; i++) {
          const t = i / Math.max(1, count - 1);
          out.push({ x: i * 0.7, y: 300 + Math.sin(t * Math.PI * 4) * 60 });
        }
      } else {
        for (let i = 0; i < count; i++) {
          const a = (i / 40) * Math.PI * 2;
          const cx = 100 + Math.floor(i / 40) * 30;
          out.push({ x: cx + Math.cos(a) * 20, y: 300 + Math.sin(a) * 20 });
        }
      }
      return out;
    }

    // Simulate the backend's frozen-head + mutable-tail: head is a closed
    // ring (left forward + right back), tail is a small closed ring.
    function ringFor(samples: Array<{ x: number; y: number }>): Path2D {
      const p = new Path2D();
      const w = 2;
      p.moveTo(samples[0]!.x, samples[0]!.y - w);
      for (let i = 1; i < samples.length; i++)
        p.lineTo(samples[i]!.x, samples[i]!.y - w);
      for (let i = samples.length - 1; i >= 0; i--)
        p.lineTo(samples[i]!.x, samples[i]!.y + w);
      p.closePath();
      return p;
    }

    const sizes = [100, 1000, 5000, 10000, 20000];
    const shapes = ['straight', 's-curve', 'circles'];
    const medians: Record<string, Record<string, number>> = {};
    const p95s: Record<string, Record<string, number>> = {};
    for (const shape of shapes) {
      medians[shape] = {};
      p95s[shape] = {};
      for (const size of sizes) {
        const samples = shapeSamples(shape, size);
        const head = ringFor(samples.slice(0, Math.max(1, size - 20)));
        const tail = ringFor(samples.slice(Math.max(0, size - 21)));
        const times: number[] = [];
        for (let k = 0; k < 30; k++) {
          const t0 = performance.now();
          const combined = new Path2D();
          combined.addPath(head);
          combined.addPath(tail);
          ctx.fill(combined);
          times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        medians[shape]![String(size)] = times[Math.floor(times.length / 2)]!;
        p95s[shape]![String(size)] = times[Math.floor(times.length * 0.95)]!;
      }
    }
    return { medians, p95s };
  })) as { medians: BenchPoint['mediansMs']; p95s: BenchPoint['p95Ms'] };

  console.log(`frozen-head Chromium medians: ${JSON.stringify(result.medians)}`);
  console.log(`frozen-head Chromium p95: ${JSON.stringify(result.p95s)}`);

  // The strategy holds when 20k history costs no more than a small
  // multiple of 100 samples (native addPath replay, not retrace) and every
  // size stays inside a frame-friendly absolute budget.
  for (const shape of ['straight', 's-curve', 'circles']) {
    const med100 = result.medians[shape]!['100']!;
    const med20k = result.medians[shape]!['20000']!;
    expect(
      med20k,
      `${shape}: 20k median ${med20k}ms vs 100 median ${med100}ms`,
    ).toBeLessThanOrEqual(Math.max(4, med100 * 4 + 1));
    for (const size of ['100', '1000', '5000', '10000', '20000']) {
      expect(result.p95s[shape]![size]!).toBeLessThan(16);
    }
  }
});

test('prediction seam is pixel-clean in one fill (Chromium)', async ({
  page,
}) => {
  await page.goto('about:blank');
  const seam = (await page.evaluate(() => {
    const W = 300;
    const H = 120;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    // White background, black ink: gaps read bright, double-fills read
    // identically (opaque) — the translucent case is covered headless by
    // the single-fill structural gate plus the alpha test below.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    // Straight horizontal stroke, width 10: head [0,60), tail [59,120).
    const head = new Path2D();
    head.moveTo(10, 50);
    head.lineTo(70, 50);
    head.lineTo(70, 60);
    head.lineTo(10, 60);
    head.closePath();
    const tail = new Path2D();
    // Explicit new subpath sharing exactly the seam edge x=70 (no chord,
    // no gap, no overlap area).
    tail.moveTo(70, 50);
    tail.lineTo(130, 50);
    tail.lineTo(130, 60);
    tail.lineTo(70, 60);
    tail.closePath();
    const combined = new Path2D();
    combined.addPath(head);
    combined.addPath(tail);
    ctx.fill(combined);
    const seamCol = ctx.getImageData(70, 40, 1, 40).data;
    let dark = 0;
    let bright = 0;
    for (let y = 0; y < 40; y++) {
      const r = seamCol[y * 4]!;
      if (r < 128) dark += 1;
      else bright += 1;
    }
    // The seam column must be fully inked across the stroke width
    // (rows 10..20 map to y=50..60) with no bright hairline.
    const inkRows: number[] = [];
    for (let y = 10; y < 20; y++) inkRows.push(seamCol[y * 4]!);
    // Off-stroke rows above/below must stay background (no chord fills).
    const above = seamCol[5 * 4]!;
    const below = seamCol[30 * 4]!;
    return { inkRows, above, below, dark, bright };
  })) as { inkRows: number[]; above: number; below: number; dark: number; bright: number };

  expect(seam.inkRows.every((v) => v < 128)).toBe(true);
  expect(seam.above).toBeGreaterThan(200);
  expect(seam.below).toBeGreaterThan(200);
});

test('translucent highlighter seam does not double-darken (Chromium)', async ({
  page,
}) => {
  await page.goto('about:blank');
  const alpha = (await page.evaluate(() => {
    const W = 300;
    const H = 120;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#ff0';
    const head = new Path2D();
    head.moveTo(10, 50);
    head.lineTo(70, 50);
    head.lineTo(70, 60);
    head.lineTo(10, 60);
    head.closePath();
    const tail = new Path2D();
    tail.moveTo(70, 50);
    tail.lineTo(130, 50);
    tail.lineTo(130, 60);
    tail.lineTo(70, 60);
    tail.closePath();
    const combined = new Path2D();
    combined.addPath(head);
    combined.addPath(tail);
    ctx.fill(combined);
    ctx.globalAlpha = 1;
    const mid = ctx.getImageData(40, 55, 1, 1).data;
    const seam = ctx.getImageData(70, 55, 1, 1).data;
    return {
      mid: [mid[0], mid[1], mid[2]],
      seam: [seam[0], seam[1], seam[2]],
    };
  })) as { mid: number[]; seam: number[] };

  // Shared-edge single fill: seam pixel equals mid-stroke pixel (a double
  // fill of overlapping area would darken the seam measurably).
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(alpha.seam[i]! - alpha.mid[i]!)).toBeLessThanOrEqual(4);
  }
});

test('two-fill prediction path (head item + tail item) stays seam-clean (Chromium)', async ({
  page,
}) => {
  // Production prediction architecture: the confirmed head item and the
  // predicted tail item are TWO separate fills (prediction stays
  // ephemeral, never merged into canonical geometry). Abutting butt seams
  // share exactly one edge (zero area) — prove no dark seam, light
  // hairline, or chord appears, opaque and translucent.
  await page.goto('about:blank');
  const twoFill = (await page.evaluate(() => {
    const read = (alpha: number): { mid: number[]; seam: number[]; above: number } => {
      const W = 300;
      const H = 120;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = alpha === 1 ? '#000' : '#ff0';
      const head = new Path2D();
      head.moveTo(10, 50);
      head.lineTo(70, 50);
      head.lineTo(70, 60);
      head.lineTo(10, 60);
      head.closePath();
      ctx.fill(head);
      const tail = new Path2D();
      tail.moveTo(70, 50);
      tail.lineTo(130, 50);
      tail.lineTo(130, 60);
      tail.lineTo(70, 60);
      tail.closePath();
      ctx.fill(tail);
      ctx.globalAlpha = 1;
      const mid = ctx.getImageData(40, 55, 1, 1).data;
      const seam = ctx.getImageData(70, 55, 1, 1).data;
      const above = ctx.getImageData(70, 30, 1, 1).data[0]!;
      return { mid: [mid[0], mid[1], mid[2]], seam: [seam[0], seam[1], seam[2]], above };
    };
    return { opaque: read(1), translucent: read(0.5) };
  })) as {
    opaque: { mid: number[]; seam: number[]; above: number };
    translucent: { mid: number[]; seam: number[]; above: number };
  };

  // Opaque: seam identical to mid-stroke, no chord above.
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(twoFill.opaque.seam[i]! - twoFill.opaque.mid[i]!)).toBeLessThanOrEqual(6);
  }
  expect(twoFill.opaque.above).toBeGreaterThan(200);
  // Translucent: seam matches mid-stroke within antialiasing tolerance
  // (two abutting fills antialias the shared edge independently — allow a
  // slightly wider band than the single-fill path, but no dark overlap or
  // bright gap).
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(twoFill.translucent.seam[i]! - twoFill.translucent.mid[i]!)).toBeLessThanOrEqual(12);
  }
  expect(twoFill.translucent.above).toBeGreaterThan(200);
});
