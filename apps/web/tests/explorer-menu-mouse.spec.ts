import { expect, test } from '@playwright/test';

test('file actions stay open while moving the mouse from the row to a menu item', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Mouse menu');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  await page.getByRole('button', { name: 'welcome.md', exact: true }).hover();
  const options = page.getByRole('button', { name: 'welcome.md options' });
  await options.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const rename = menu.getByRole('menuitem', { name: /Rename/ });
  const from = await options.boundingBox();
  const to = await rename.boundingBox();
  if (from === null || to === null) throw new Error('Menu geometry unavailable');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 12,
  });
  await expect(menu).toBeVisible();
  await expect(options).toHaveAttribute('data-fl-menu-open', '');
  await rename.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(options).not.toHaveAttribute('data-fl-menu-open', '');
});
