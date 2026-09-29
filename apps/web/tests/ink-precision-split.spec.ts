import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

test.use({ viewport: { width: 1360, height: 1000 }, serviceWorkers: 'block' });

test('a precise cut persists as separately erasable strokes in a disposable vault', async ({
  page,
}) => {
  test.setTimeout(90_000);
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
  await page
    .getByTestId('create-vault-name-input')
    .fill('Precision disposable');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Whiteboard');
  await page
    .getByRole('textbox', { name: 'Note name' })
    .fill('Precision split');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.locator('.fl-ink-canvas').first()).toBeVisible();
  const left = { x: 490, y: 480, width: 170, height: 40 };
  const right = { x: 760, y: 480, width: 150, height: 40 };
  await page.mouse.move(20, 20);
  const blank = await page.screenshot({ clip: left });
  await page.mouse.move(500, 500);
  await page.mouse.down();
  await page.mouse.move(900, 500, { steps: 60 });
  await page.mouse.up();
  await page.mouse.move(20, 20);
  await expect
    .poll(async () => (await page.screenshot({ clip: left })).equals(blank))
    .toBe(false);
  const originalRight = await page.screenshot({ clip: right });
  const categories = page.getByRole('toolbar', {
    name: 'Document tool categories',
  });
  await categories.getByRole('button', { name: 'Eraser', exact: true }).click();
  await page
    .getByRole('button', { name: 'Precision Eraser', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(700, 550, { steps: 20 });
  await page.mouse.up();
  await page.mouse.move(20, 20);
  const unselectedArea = { x: 800, y: 490, width: 100, height: 20 };
  const unselectedPixels = await page.screenshot({ clip: unselectedArea });
  await categories
    .getByRole('button', { name: 'Selection', exact: true })
    .click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.mouse.click(550, 500);
  await page.mouse.move(20, 20);
  // Selecting the left fragment must not draw its border around the right one.
  await expect
    .poll(async () =>
      (await page.screenshot({ clip: unselectedArea })).equals(
        unselectedPixels,
      ),
    )
    .toBe(true);
  await page.mouse.click(1000, 650);
  await page.keyboard.press('Control+s');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const directory = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle('Precision disposable');
        const file = await (
          await directory.getFileHandle('Precision split.whiteboard')
        ).getFile();
        const model = JSON.parse(await file.text());
        return model.order.length;
      }),
    )
    .toBe(2);
  await page.reload();
  await page
    .getByRole('button', { name: /Precision disposable Browser/ })
    .click();
  await page
    .getByRole('button', { name: 'Precision split.whiteboard', exact: true })
    .click();
  await expect(page.locator('.fl-ink-canvas').first()).toBeVisible();
  await page
    .getByRole('toolbar', { name: 'Document tool categories' })
    .getByRole('button', { name: 'Eraser', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Stroke Eraser', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await page.mouse.click(550, 500);
  await page.mouse.move(20, 20);
  await expect
    .poll(async () => (await page.screenshot({ clip: left })).equals(blank))
    .toBe(true);
  await expect
    .poll(async () =>
      (await page.screenshot({ clip: right })).equals(originalRight),
    )
    .toBe(true);
  await page.keyboard.press('Control+z');
  await page.mouse.move(20, 20);
  await expect
    .poll(async () => (await page.screenshot({ clip: left })).equals(blank))
    .toBe(false);
  await expect(page.locator('.fl-ink-canvas').first()).toBeVisible();
  expect(errors).toEqual([]);
});
