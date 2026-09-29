/**
 * Real-browser ink release benchmark (final scalability pass, item 7).
 *
 * Drives `/bench/index.html` in Chromium: the REAL `mountInkSurface`
 * stack with actual Canvas2D rasterization and the browser
 * `requestAnimationFrame` pipeline (the jsdom `release-benchmark` suite
 * stubs both and is structural-only).
 *
 * CI asserts machine-independent structural invariants (zero recompiles,
 * zero geometry copies, one drag promotion, zero full translation
 * repaints, exact repainted-item counts). Wall-clock timings are printed
 * for physical-device comparison — never asserted absolutely.
 */

import { expect, test } from '@playwright/test';

/**
 * The bench harness is not the PWA shell: the production service worker's
 * `navigateFallback: 'index.html'` would hijack later `/bench/index.html`
 * navigations (the reload-durability tests intentionally navigate twice),
 * so service workers are blocked for this suite. The PWA offline contract
 * is covered by `offline-shell.spec.ts` in the pwa-offline CI job.
 */
test.use({ serviceWorkers: 'block' });

interface BenchResult {
  readonly label: string;
  readonly samples: number;
  readonly zoom: number;
  readonly pointerUpMs: number;
  readonly canonicalMs: number;
  readonly derivedMs: number;
  readonly paintedFrameMs: number;
  readonly openToFirstPaintMs: number;
  readonly firstProgressPending: number;
  readonly recompiles: number;
  readonly geometryCopies: number;
  readonly transformUpdates: number;
  readonly dragPromotions: number;
  readonly translationFullRepaints: number;
  readonly repaintedItems: number;
  readonly canonicalSamplesTranslated: number;
  readonly expectedSamples: number;
  readonly expectedMovedItems: number;
}

test('ink release runs on real Canvas2D and rAF with zero recompiles/copies', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/bench/index.html');
  await page.waitForFunction(
    () =>
      (window as unknown as { __froglightInkBench?: { done?: boolean } })
        .__froglightInkBench?.done === true,
    undefined,
    { timeout: 840_000 },
  );
  const report = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __froglightInkBench: {
            done: boolean;
            results: BenchResult[];
            errors: { label: string; message: string }[];
          };
        }
      ).__froglightInkBench,
  )) as {
    done: boolean;
    results: BenchResult[];
    errors: { label: string; message: string }[];
  };

  // eslint-disable-next-line no-console
  console.log(
    `browser-release timings (ms): ${report.results
      .map(
        (result) =>
          `${result.label}: openToFirstPaint=${result.openToFirstPaintMs.toFixed(2)} ` +
          `firstProgressPending=${result.firstProgressPending} ` +
          `pointerUp=${result.pointerUpMs.toFixed(2)} ` +
          `canonical=${result.canonicalMs.toFixed(2)} ` +
          `derived=${result.derivedMs.toFixed(2)} ` +
          `paintedFrame=${result.paintedFrameMs.toFixed(2)}`,
      )
      .join(' | ')}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `browser-release counters: ${report.results
      .map(
        (result) =>
          `${result.label}: recompiles=${result.recompiles} ` +
          `copies=${result.geometryCopies} promotions=${result.dragPromotions} ` +
          `fullRepaints=${result.translationFullRepaints} ` +
          `repainted=${result.repaintedItems} transforms=${result.transformUpdates}`,
      )
      .join(' | ')}`,
  );

  expect(report.errors, JSON.stringify(report.errors)).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(report.results.length).toBe(9);
  for (const result of report.results) {
    expect(result.recompiles, `${result.label} recompiles`).toBe(0);
    expect(result.geometryCopies, `${result.label} geometry copies`).toBe(0);
    expect(result.dragPromotions, `${result.label} drag promotions`).toBe(1);
    expect(
      result.translationFullRepaints,
      `${result.label} full translation repaints`,
    ).toBe(0);
    expect(result.repaintedItems, `${result.label} repainted items`).toBe(
      result.expectedMovedItems,
    );
    expect(
      result.canonicalSamplesTranslated,
      `${result.label} canonical samples translated`,
    ).toBe(result.expectedSamples);
    expect(
      result.transformUpdates,
      `${result.label} transform updates`,
    ).toBeLessThanOrEqual(Math.max(1, result.expectedMovedItems));
    // Background preparation after open is bounded to the viewport +
    // prefetch margin + a bounded lookahead — never the whole document.
    expect(
      result.firstProgressPending,
      `${result.label} first-paint progressive queue`,
    ).toBeLessThanOrEqual(513);
    expect(Number.isFinite(result.pointerUpMs)).toBe(true);
    expect(Number.isFinite(result.paintedFrameMs)).toBe(true);
  }
  const zoomed = report.results.find((result) =>
    result.label.endsWith('@0.5x'),
  );
  expect(zoomed).toBeDefined();
  expect(zoomed!.zoom).toBeCloseTo(0.5, 5);
});

test('derived cache survives a browser reload through OPFS host storage', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // First load: warm a stroke and persist it through the real OPFS
  // derived-cache storage port (the production web host wiring).
  await page.goto('/bench/index.html?mode=reopen-write');
  await page.waitForFunction(
    () =>
      (window as unknown as { __froglightInkBench?: { done?: boolean } })
        .__froglightInkBench?.done === true,
    undefined,
    { timeout: 60_000 },
  );
  const write = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __froglightInkBench: {
            reopen?: { mode: string; warmed: boolean };
          };
        }
      ).__froglightInkBench.reopen,
  )) as { mode: string; warmed: boolean } | undefined;
  expect(write?.mode).toBe('write');
  expect(write?.warmed).toBe(true);

  // Second load (actual browser page reload): fresh store, fresh model,
  // same OPFS record. Restore must hit with zero B-spline compiles.
  await page.goto('/bench/index.html?mode=reopen-read');
  await page.waitForFunction(
    () =>
      (window as unknown as { __froglightInkBench?: { done?: boolean } })
        .__froglightInkBench?.done === true,
    undefined,
    { timeout: 60_000 },
  );
  const read = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __froglightInkBench: {
            reopen?: {
              mode: string;
              hits: number;
              misses: number;
              computes: number;
              warmed: boolean;
            };
          };
        }
      ).__froglightInkBench.reopen,
  )) as
    | {
        mode: string;
        hits: number;
        misses: number;
        computes: number;
        warmed: boolean;
      }
    | undefined;
  const errors = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __froglightInkBench: {
            errors: { label: string; message: string }[];
          };
        }
      ).__froglightInkBench.errors,
  )) as { label: string; message: string }[];
  expect(errors, JSON.stringify(errors)).toEqual([]);
  expect(read?.mode).toBe('read');
  // Lazy viewport-first restore: the visible stroke is unpacked when the
  // first frame reaches it, with zero B-spline compiles.
  expect(read?.hits).toBeGreaterThanOrEqual(1);
  expect(read?.misses).toBe(0);
  expect(read?.computes).toBe(0);
  expect(read?.warmed).toBe(true);
});

/**
 * Dense-Ink suite (dense-document pass): structural invariants only, no
 * brittle wall-clock assertions. Timings are printed for physical-device
 * comparison.
 */
interface DenseBenchResult {
  readonly label: string;
  readonly strokes: number;
  readonly samplesPerStroke: number;
  readonly canonicalDecodeMs: number;
  readonly openToFirstPaintMs: number;
  readonly firstPaintPrepared: number;
  readonly firstPaintPending: number;
  readonly firstPaintRestored: number;
  readonly firstPaintRestoreMisses: number;
  readonly firstPaintComputes: number;
  readonly firstPaintFullRebuilds: number;
  readonly restoredAfterHydration: number;
  readonly totalRestored: number;
  readonly totalComputes: number;
  readonly workerCompiles: number;
  readonly workerIntegrationMs: number;
  readonly workerOutputBytes: number;
  readonly cachedPackedRestoreMs: number;
  readonly progressiveMs: number;
  readonly totalPrepared: number;
  readonly packedBytesWarm: number;
  readonly warmRecords: number;
}

interface DenseReport {
  readonly done: boolean;
  readonly errors: { label: string; message: string }[];
  readonly dense?: {
    readonly mode: string;
    readonly results: DenseBenchResult[];
  };
}

async function runDenseMode(
  page: import('@playwright/test').Page,
  mode: 'dense-open' | 'dense-write' | 'dense-read' | 'dense-hydrate',
): Promise<DenseBenchResult[]> {
  await page.goto(`/bench/index.html?mode=${mode}`);
  await page.waitForFunction(
    () =>
      (window as unknown as { __froglightInkBench?: { done?: boolean } })
        .__froglightInkBench?.done === true,
    undefined,
    { timeout: 840_000 },
  );
  const report = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __froglightInkBench: DenseReport;
        }
      ).__froglightInkBench,
  )) as DenseReport;
  // eslint-disable-next-line no-console
  console.log(
    `browser-dense ${mode}: ${report.dense?.results
      .map(
        (result) =>
          `${result.label}: firstPaint=${result.openToFirstPaintMs.toFixed(1)}ms ` +
          `prepared=${result.firstPaintPrepared} pending=${result.firstPaintPending} ` +
          `restored=${result.firstPaintRestored} computes=${result.firstPaintComputes} ` +
          `afterHydrate=${result.restoredAfterHydration} ` +
          `totalRestored=${result.totalRestored} totalComputes=${result.totalComputes} ` +
          `worker=${result.workerCompiles} totalPrepared=${result.totalPrepared} ` +
          `unpackMs=${result.cachedPackedRestoreMs.toFixed(1)} ` +
          `progressive=${result.progressiveMs.toFixed(1)}ms ` +
          `packedBytes=${result.packedBytesWarm}`,
      )
      .join(' | ')}`,
  );
  expect(report.errors, JSON.stringify(report.errors)).toEqual([]);
  expect(report.dense?.mode).toBe(mode);
  expect(report.dense?.results).toHaveLength(4);
  return report.dense!.results;
}

test('dense uncached Ink open is viewport-bounded (real Chromium)', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const results = await runDenseMode(page, 'dense-open');
  expect(pageErrors).toEqual([]);
  for (const result of results) {
    // No cached vectors in an uncached open; viewport work is bounded.
    expect(result.firstPaintRestored, result.label).toBe(0);
    expect(result.firstPaintPrepared, result.label).toBeLessThanOrEqual(120);
    expect(result.firstPaintPending, result.label).toBeLessThanOrEqual(
      result.strokes,
    );
    // At least the first-paint rebuild happened in this measured window
    // (a progressive repaint may race into the same frame); the structural
    // bound is the prepared-item count above, never a whole-document paint.
    expect(result.firstPaintFullRebuilds, result.label).toBeGreaterThanOrEqual(
      1,
    );
    // Progressive preparation completes (deferred huge strokes hydrate via
    // the Worker) and every object ends prepared.
    expect(result.totalPrepared, result.label).toBe(result.strokes);
  }
});

test('dense cached reopen restores visible vectors lazily without compiles', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const write = await runDenseMode(page, 'dense-write');
  expect(pageErrors).toEqual([]);
  for (const result of write) {
    // The full document was viewport-warmed before persistence.
    expect(result.warmRecords, result.label).toBe(result.strokes);
  }

  const read = await runDenseMode(page, 'dense-read');
  for (const result of read) {
    // First paint unpacks only a bounded viewport subset — never the whole
    // cached document. Every prepared object is either a lazy restore or a
    // genuine miss; cached restores never recompile.
    expect(result.firstPaintRestored, result.label).toBeLessThanOrEqual(120);
    expect(result.firstPaintComputes, result.label).toBe(
      result.firstPaintRestoreMisses,
    );
    expect(
      result.firstPaintRestored + result.firstPaintRestoreMisses,
      result.label,
    ).toBe(result.firstPaintPrepared);
    expect(result.firstPaintPending, result.label).toBeGreaterThan(0);
    expect(result.firstPaintFullRebuilds, result.label).toBeGreaterThanOrEqual(
      1,
    );
    // Progressive completion restores cached entries (Worker compiles only
    // genuine misses) and every stroke is restored or compiled exactly once
    // (main-thread compile or Worker cold compile).
    expect(result.totalRestored, result.label).toBeGreaterThan(0);
    expect(
      result.totalRestored + result.totalComputes + result.workerCompiles,
      result.label,
    ).toBe(result.strokes);
    expect(result.totalPrepared, result.label).toBe(result.strokes);
  }
});

test('async OPFS hydration does not synchronously restore the whole document', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await runDenseMode(page, 'dense-write');
  const hydrate = await runDenseMode(page, 'dense-hydrate');
  expect(pageErrors).toEqual([]);
  for (const result of hydrate) {
    // Mount happened before hydration resolved: no whole-document restore.
    expect(result.firstPaintRestored, result.label).toBeLessThan(
      result.strokes,
    );
    expect(result.totalRestored, result.label).toBeLessThanOrEqual(
      result.strokes,
    );
    // Every stroke is restored lazily or compiled (sync or Worker); the
    // document completes.
    expect(
      result.totalRestored + result.totalComputes + result.workerCompiles,
      result.label,
    ).toBe(result.strokes);
    expect(result.totalPrepared, result.label).toBe(result.strokes);
  }
});
