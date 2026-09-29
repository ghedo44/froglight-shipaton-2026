import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test('tab context menu closes every tab in its pane and keeps the files', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Close all tabs');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  await createFromSidebar(page, 'Markdown');
  const create = page.getByRole('dialog', { name: 'Create a new note' });
  await create.getByRole('textbox', { name: 'Note name' }).fill('Second');
  await create.getByRole('button', { name: 'Create', exact: true }).click();

  const welcome = page.getByRole('tab', { name: 'welcome.md', exact: true });
  const second = page.getByRole('tab', { name: 'Second.md', exact: true });
  await expect(welcome).toBeVisible();
  await expect(second).toBeVisible();
  await welcome.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close all', exact: true }).click();
  await expect(welcome).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'welcome.md', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Second.md', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'welcome.md', exact: true }).click();
  await welcome.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Close all', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Close all', exact: true }).click();
  await expect(welcome).toHaveCount(0);

  await page.getByRole('button', { name: 'welcome.md', exact: true }).click();
  await page.getByRole('button', { name: 'Second.md', exact: true }).click();
  await welcome.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Split right with this tab' }).click();
  await expect(page.locator('[data-pane-strip]')).toHaveCount(2);
  await page
    .locator('[data-pane-strip="main"]')
    .getByRole('tab', { name: 'Second.md', exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close all', exact: true }).click();
  await expect(second).toHaveCount(0);
  await expect(welcome).toHaveCount(1);
});
