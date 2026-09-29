import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test('Notebook keeps an empty Outline tab without page rows', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Notebook outline');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Notebook');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Paper');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Paper.notebook', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle document sidebar', exact: true }).click();
  await page.getByRole('tab', { name: 'Outline', exact: true }).click();
  const outline = page.getByRole('tabpanel', { name: 'Outline' });
  await expect(outline).toBeVisible();
  await expect(outline).toHaveText('');
  await page.screenshot({
    path: test.info().outputPath('notebook-empty-outline.png'),
    animations: 'disabled',
  });
});
