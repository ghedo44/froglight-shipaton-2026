import { createFromSidebar } from './support/sidebar-create.js';
import {
  clickDatabaseAction,
  openDocumentProperties,
} from './support/database-actions.js';
import { expect, test } from '@playwright/test';

test('trash and collision-safe restore preserve document properties', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Trash recovery');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Research');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const database = page.getByRole('region', { name: 'Research', exact: true });
  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Property name', exact: true })
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
  await openDocumentProperties(page);
  const panel = page.getByRole('tabpanel', { name: 'Properties' });
  await panel.getByRole('textbox', { name: 'Topic' }).fill('Physics');
  await panel.getByRole('textbox', { name: 'Topic' }).press('Tab');
  await expect(panel.getByRole('textbox', { name: 'Topic' })).toHaveValue(
    'Physics',
  );

  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await sidebar.locator('[data-path="Paper.md"]').hover();
  await page.getByRole('button', { name: 'Paper.md options' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog', {
    name: 'Move “Paper.md” to Trash?',
  });
  await confirm.getByRole('button', { name: 'Move to Trash' }).click();
  await expect(
    sidebar.getByRole('button', { name: 'Paper.md', exact: true }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole('button', { name: 'Trash (1)' }),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Research.base' }).click();
  await database.getByRole('button', { name: 'New item', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('textbox', { name: 'Note name' })
    .fill('Paper');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Paper.md' })).toBeVisible();
  await sidebar.getByRole('button', { name: 'Trash (1)' }).click();
  await sidebar.getByRole('button', { name: 'Restore Paper.md' }).click();
  await expect(page.getByRole('tab', { name: 'Paper (1).md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await openDocumentProperties(page);
  await expect(panel.getByRole('textbox', { name: 'Topic' })).toHaveValue(
    'Physics',
  );
  await expect(
    sidebar.getByRole('button', { name: 'Trash (0)' }),
  ).toBeVisible();
});
