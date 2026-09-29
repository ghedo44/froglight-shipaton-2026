import { expect, test } from '@playwright/test';

interface BenchReport {
  done: boolean;
  error?: string;
  samples: {
    rows: number;
    selected: number;
    mountedRows: number;
    firstUsableMs: number;
    warmRefreshP95Ms: number;
    queryP95Ms: number;
  }[];
}

type BenchWindow = Window & { __froglightDatabaseBench?: BenchReport };

test.use({ serviceWorkers: 'block' });

test('database evaluator and table render stay bounded in a real browser', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/bench/database.html');
  await page.waitForFunction(
    () => (window as BenchWindow).__froglightDatabaseBench?.done === true,
  );
  const report = await page.evaluate(
    () => (window as BenchWindow).__froglightDatabaseBench,
  );
  expect(report?.error).toBeUndefined();
  expect(report?.samples.map((sample) => sample.rows)).toEqual([
    100, 1_000, 10_000,
  ]);
  for (const sample of report?.samples ?? []) {
    expect(sample.selected).toBeGreaterThan(0);
    expect(sample.mountedRows).toBeLessThanOrEqual(101);
    expect(sample.firstUsableMs).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
  console.log(`database browser profile: ${JSON.stringify(report?.samples)}`);
});
