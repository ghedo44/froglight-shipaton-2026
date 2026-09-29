import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

// Uses the assembled provider and real canvas in a disposable OPFS vault.
// Browser mouse input checks layout stability, not physical stylus behavior.
test('Notebook viewport stays fixed when scrolling returns to the top during a stroke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Viewport acceptance');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Notebook');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Viewport');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const canvas = page.locator('.fl-ink-canvas').first();
  const pager = page.locator('.fl-nb-scroll').first();
  await expect(canvas).toBeVisible();
  await page
    .getByRole('toolbar', { name: 'Document tool categories' })
    .getByRole('button', { name: 'Pen', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await pager.evaluate((element) => {
    element.scrollTop = 8;
  });
  await expect
    .poll(() => pager.evaluate((element) => element.scrollTop))
    .toBe(8);
  // Wait for geometry to settle, including any host transition triggered by scroll.
  await pager.evaluate(async (element) => {
    let previous = element.getBoundingClientRect().top;
    let stable = 0;
    for (let frame = 0; frame < 120 && stable < 20; frame++) {
      await new Promise(requestAnimationFrame);
      const current = element.getBoundingClientRect().top;
      stable = Math.abs(current - previous) < 0.01 ? stable + 1 : 0;
      previous = current;
    }
  });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Notebook canvas has no layout');
  const x = box.x + box.width * 0.4;
  const y = Math.max(box.y, 180) + 100;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const positions = [
    await pager.evaluate((element) => element.getBoundingClientRect().top),
  ];
  await pager.evaluate((element) => {
    element.scrollTop = 0;
  });
  for (let sample = 1; sample <= 24; sample++) {
    await page.mouse.move(x + sample * 3, y + sample);
    positions.push(
      await pager.evaluate(async (element) => {
        await new Promise(requestAnimationFrame);
        return element.getBoundingClientRect().top;
      }),
    );
  }
  await page.mouse.up();
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(0.5);
  expect(await pager.evaluate((element) => element.scrollTop)).toBe(0);
  expect(errors).toEqual([]);
});
