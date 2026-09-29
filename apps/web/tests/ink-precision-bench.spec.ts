import { expect, test } from '@playwright/test';

interface PrecisionReport {
  done: boolean;
  errors: unknown[];
  precision: Record<string, number>;
}

test.use({ serviceWorkers: 'block' });

for (const size of ['small', 'dense', 'diagonal', 'stacked']) {
  test(`precision eraser and progressive paint stay local (${size})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/bench/index.html?mode=precision&size=${size}`);
    await page.waitForFunction(
      () =>
        (window as unknown as { __froglightInkBench?: PrecisionReport })
          .__froglightInkBench?.done,
      undefined,
      { timeout: 90_000 },
    );
    const report = await page.evaluate(
      () =>
        (window as unknown as { __froglightInkBench: PrecisionReport })
          .__froglightInkBench,
    );
    expect(errors).toEqual([]);
    expect(report.errors).toEqual([]);
    const result = report.precision!;
    // eslint-disable-next-line no-console
    console.log(`precision ${size}: ${JSON.stringify(result)}`);
    expect(result.initialDraws).toBe(result.strokes);
    expect(result.fullEraseRepaints).toBe(0);
    expect(result.eraseDraws).toBeLessThan(
      result.strokes! * (size === 'diagonal' || size === 'stacked' ? 10 : 1),
    );
    // This remains a movement smoke budget. Release is measured separately
    // and excludes asynchronous preparation and publication.
    if (size === 'stacked') expect(result.moveMaxMs).toBeLessThan(15_000);
    expect(result.historyEntries).toBe(1);
    expect(result.erased! + result.removed!).toBeGreaterThan(0);
    // Actual Canvas2D pixels, including antialiasing and translucent overlaps.
    expect(result.repairPixelDifference).toBe(0);
    expect(result.reopenPixelDifference).toBe(0);
    expect(result.releaseMs).toBeLessThan(50);
    expect(result.undoPixelDifference).toBe(0);
    expect(result.redoPixelDifference).toBe(0);
  });
}
