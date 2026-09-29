import { expect, test } from '@playwright/test';

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
  'base64',
);

test('Markdown links to existing raw files open their previews', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Raw link');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  const explorer = page.getByTestId('file-explorer');
  await explorer.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import file' }).click();
  await explorer.locator('input[type=file]:not([accept])').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: pixel,
  });
  await expect(explorer.getByText('pixel.png')).toBeVisible();
  await explorer.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import file' }).click();
  await explorer.locator('input[type=file]:not([accept])').setInputFiles({
    name: 'report.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Existing report'),
  });
  await expect(explorer.getByText('report.txt')).toBeVisible();

  const editor = page.locator('.froglight-markdown-editor .cm-content');
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('# Welcome\n\n![[pixel.png]]\n\n[[report.txt]]');
  await page.keyboard.press('Control+s');
  await page.locator('.froglight-wiki-link').first().click();

  await expect(page.getByRole('tab', { name: 'pixel.png', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'pixel.png.md', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-fl-component="file-preview"]')).toBeVisible();
  await page.getByRole('tab', { name: 'welcome.md', exact: true }).click();
  await page.locator('.froglight-wiki-link').last().click();
  await expect(page.getByRole('tab', { name: 'report.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'report.txt.md', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-fl-component="file-preview"]')).toContainText('Existing report');
});
