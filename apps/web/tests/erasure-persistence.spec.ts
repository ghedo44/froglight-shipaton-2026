import { expect, test } from '@playwright/test';
test.use({ serviceWorkers: 'block' });
test('shared ink sources survive actual worker restart and rejected journal admission in every family', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/bench/index.html?mode=erasure-persistence');
  await page.waitForFunction(
    () =>
      (window as unknown as { __froglightInkBench?: { done: boolean } })
        .__froglightInkBench?.done,
    undefined,
    { timeout: 90_000 },
  );
  const result = await page.evaluate(
    () =>
      (
        window as unknown as {
          __froglightInkBench: {
            errors: unknown[];
            precision: Record<string, number>;
          };
        }
      ).__froglightInkBench,
  );
  expect(result.errors).toEqual([]);
  expect(Object.keys(result.precision)).toHaveLength(3);
});
