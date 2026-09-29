import { createFromSidebar } from './support/sidebar-create.js';
import {
  clickDatabaseAction,
  openDocumentProperties,
} from './support/database-actions.js';
import { expect, test } from '@playwright/test';

test('removing a property keeps assigned values recoverable', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Schema removal');
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
  await expect(panel.getByText('Saving…')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Research.base' }).click();
  await expect(database.getByRole('row', { name: /Paper/ })).toContainText(
    'Physics',
  );
  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Remove Topic property' }).click();
  await expect(
    page.getByText('Remove property definition complete.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await page.getByRole('tab', { name: 'Paper.md' }).click();
  await expect(page.locator('.cm-content')).toContainText('Physics');
});
