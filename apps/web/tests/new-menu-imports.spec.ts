import { expect, test } from '@playwright/test';

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
  'base64',
);

test('New menu creates documents and imports files and images', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('New menu imports');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  const explorer = page.getByTestId('file-explorer');
  const openMenu = async () => {
    await explorer.getByRole('button', { name: 'New', exact: true }).click();
    return page.getByRole('menu');
  };

  const menu = await openMenu();
  await expect(menu.getByRole('menuitem')).toHaveText([
    'New document',
    'New folder',
    'Import PDF as notebook',
    'Import image as ink',
    'Import file',
  ]);
  await menu.getByRole('menuitem', { name: 'New document' }).click();
  const create = page.getByRole('dialog', { name: 'Create a new note' });
  await expect(create.getByRole('radio', { name: 'Markdown' })).toBeVisible();
  await expect(create.getByRole('radio', { name: 'Ink page' })).toBeVisible();
  await create.getByRole('textbox', { name: 'Note name' }).fill('Menu document');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Menu document.md' })).toBeVisible();

  await (await openMenu()).getByRole('menuitem', { name: 'Import file' }).click();
  await explorer.locator('input[type=file]:not([accept])').setInputFiles({
    name: 'archive.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([1, 2, 3]),
  });
  await expect(explorer.getByText('archive.bin')).toBeVisible();

  await (await openMenu()).getByRole('menuitem', { name: 'Import file' }).click();
  await explorer.locator('input[type=file]:not([accept])').setInputFiles({
    name: 'draft.ltx',
    mimeType: 'text/x-tex',
    buffer: Buffer.from('Hello LaTeX'),
  });
  await expect(explorer.getByText('draft.ltx')).toBeVisible();

  await (await openMenu())
    .getByRole('menuitem', { name: 'Import image as ink' })
    .click();
  await explorer.locator('input[type=file][accept="image/*"]').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: pixel,
  });
  await expect(page.getByRole('tab', { name: 'pixel.ink' })).toBeVisible();
  await expect(explorer.getByText('pixel.ink')).toBeVisible();
  await expect(explorer.getByText('pixel.png')).toHaveCount(0);
});
