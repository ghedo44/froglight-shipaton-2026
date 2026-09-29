import { createFromSidebar } from './support/sidebar-create.js';
import { clickDatabaseAction } from './support/database-actions.js';
import { expect, test } from '@playwright/test';

test('table property and membership actions expose one-shot logical undo', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Database undo');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Projects');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();

  const database = page.getByRole('region', { name: 'Projects', exact: true });
  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Property name', exact: true })
    .last()
    .fill('Topic');
  await page
    .getByRole('dialog', { name: 'View settings' })
    .getByRole('button', { name: 'Add property', exact: true })
    .click();
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await database.getByRole('button', { name: 'New item', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('textbox', { name: 'Note name' })
    .fill('Paper');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Paper.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Projects.base' }).click();

  await database.getByRole('button', { name: 'Edit Topic: —' }).click();
  await database.getByRole('textbox', { name: 'Topic' }).fill('Physics');
  await database.getByRole('textbox', { name: 'Topic' }).press('Enter');
  await expect(
    database.getByText('Edit database property complete.'),
  ).toBeVisible();
  await database.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    database.getByRole('button', { name: 'Edit Topic: —' }),
  ).toBeVisible();
  await expect(
    database.getByRole('button', { name: 'Undo', exact: true }),
  ).toHaveCount(0);

  await database.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(
    database.getByText('Remove database member complete.'),
  ).toBeVisible();
  await expect(
    database.getByRole('button', { name: 'Paper.md', exact: true }),
  ).toHaveCount(0);
  await database.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    database.getByRole('button', { name: 'Paper.md', exact: true }),
  ).toBeVisible();
});
