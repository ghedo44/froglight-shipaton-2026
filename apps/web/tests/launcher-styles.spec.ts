/**
 * Launcher cascade contract (real Chromium, production `dist/`).
 *
 * Regression suite for unstyled first-run UI: cascade-layer priority
 * follows first declaration, so the layer order must lead the static
 * bundle — otherwise global element resets (`button { background: none }`)
 * beat component rules (`.btn`) and the launcher renders unstyled.
 * Runs against `vite preview` like the offline suite, since dev-server
 * style-injection order can mask the production ordering.
 */
import { expect, test } from '@playwright/test';

test.describe('launcher renders styled', () => {
  test('primary and default buttons carry the committed button world', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForSelector('[data-testid="vault-launcher"]', {
      timeout: 30000,
    });

    // Tokens resolve: the runtime theme bundle applied.
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue(
          '--fl-accent-strong',
        ),
      ),
    ).toContain('604ae0');

    const create = page.getByTestId('create-vault-button');
    await expect(create).toBeVisible();
    // Primary: violet-strong fill (#604ae0), on-violet label, 30px height.
    expect(await create.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(96, 74, 224)',
    );
    expect(await create.evaluate((el) => getComputedStyle(el).color)).toBe(
      'rgb(255, 255, 255)',
    );
    expect(await create.evaluate((el) => getComputedStyle(el).height)).toBe('30px');

    const open = page.getByTestId('open-vault-button');
    await expect(open).toBeVisible();
    // Default: raised fill, hairline-strong border — not the bare `button`
    // reset (transparent background, no border).
    expect(await open.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(255, 255, 255)',
    );
    expect(await open.evaluate((el) => getComputedStyle(el).borderColor)).toContain(
      '55, 53, 47',
    );

    expect(pageErrors).toEqual([]);
  });

  test('create-vault modal actions carry the button world', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForSelector('[data-testid="vault-launcher"]', {
      timeout: 30000,
    });
    await page.getByTestId('create-vault-button').click();
    const confirm = page.getByTestId('confirm-create-vault-button');
    await expect(confirm).toBeVisible();
    expect(await confirm.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(96, 74, 224)',
    );
    const cancel = page.getByTestId('cancel-create-vault-button');
    expect(await cancel.evaluate((el) => getComputedStyle(el).height)).toBe('30px');

    expect(pageErrors).toEqual([]);
  });
});
