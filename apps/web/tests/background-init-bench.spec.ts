/**
 * Background-input initialization diagnostic.
 *
 * Drives `/bench/index.html?mode=background-init` in real Chromium: isolates
 * the one-shot O(N) typed-array allocation in `createBackgroundInputJob()`
 * (100k and 500k samples) from bounded sliced copying (≤2000/slice) and
 * Worker compilation. CI asserts structural invariants only (sample counts,
 * slice bound, byte accounting); wall-clock `initMs`/`copyMs` are printed
 * for the allocation decision and recorded in — never asserted
 * absolutely.
 */

import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

interface BackgroundInitResult {
  readonly label: string;
  readonly samples: number;
  readonly initMs: number;
  readonly copyMs: number;
  readonly copySlices: number;
  readonly maxSliceSamples: number;
  readonly inputBytes: number;
}

test('background input init isolates allocation from sliced copying (real Chromium)', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/bench/index.html?mode=background-init');
  await page.waitForFunction(
    () =>
      (window as unknown as { __froglightInkBench?: { done?: boolean } })
        .__froglightInkBench?.done === true,
    undefined,
    { timeout: 240_000 },
  );
  const report = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __froglightInkBench: {
            done: boolean;
            errors: { label: string; message: string }[];
            backgroundInit?: {
              mode: string;
              results: BackgroundInitResult[];
            };
          };
        }
      ).__froglightInkBench,
  )) as {
    done: boolean;
    errors: { label: string; message: string }[];
    backgroundInit?: { mode: string; results: BackgroundInitResult[] };
  };

  // eslint-disable-next-line no-console
  console.log(
    `browser-background-init timings (ms): ${(
      report.backgroundInit?.results ?? []
    )
      .map(
        (r) =>
          `${r.label}: initMs=${r.initMs.toFixed(2)} copyMs=${r.copyMs.toFixed(2)} ` +
          `slices=${r.copySlices} maxSlice=${r.maxSliceSamples} bytes=${r.inputBytes}`,
      )
      .join(' | ')}`,
  );

  expect(report.errors, JSON.stringify(report.errors)).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(report.backgroundInit?.mode).toBe('background-init');
  const results = report.backgroundInit?.results ?? [];
  // 100k + 500k, 3 runs each (1 cold + 2 warm).
  expect(results.length).toBe(6);
  for (const r of results) {
    expect(Number.isFinite(r.initMs)).toBe(true);
    expect(Number.isFinite(r.copyMs)).toBe(true);
    expect(r.initMs).toBeGreaterThanOrEqual(0);
    expect(r.copyMs).toBeGreaterThanOrEqual(0);
    // Sliced copying stays bounded (the existing ≤2000/slice contract).
    expect(r.maxSliceSamples, `${r.label} max slice`).toBeLessThanOrEqual(2000);
    expect(r.maxSliceSamples, `${r.label} max slice`).toBeGreaterThan(0);
    // 100k → 50 slices, 500k → 250 slices (exact, deterministic).
    if (r.samples === 100_000) expect(r.copySlices).toBe(50);
    if (r.samples === 500_000) expect(r.copySlices).toBe(250);
    expect(r.inputBytes).toBeGreaterThan(0);
  }
  const forSamples = (n: number): BackgroundInitResult[] =>
    results.filter((r) => r.samples === n);
  expect(forSamples(100_000)).toHaveLength(3);
  expect(forSamples(500_000)).toHaveLength(3);
});
