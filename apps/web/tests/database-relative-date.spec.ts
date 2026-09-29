import { createFromSidebar } from './support/sidebar-create.js';
import {
  clickDatabaseAction,
  openDocumentProperties,
} from './support/database-actions.js';
import { expect, test } from '@playwright/test';

test('relative date filter finds a document dated today', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Relative dates');
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
  const propertyForm = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Add property', exact: true }),
  });
  await propertyForm
    .getByRole('textbox', { name: 'Property name', exact: true })
    .fill('Review');
  await propertyForm
    .getByRole('combobox', { name: 'Type', exact: true })
    .selectOption('date');
  await propertyForm
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
  const today = await page.evaluate(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type: string) =>
      parts.find((item) => item.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  });
  await panel.getByRole('textbox', { name: 'Review' }).fill(today);
  await page.getByRole('tab', { name: 'Research.base' }).click();
  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('heading', { name: /^Filters ·/ }).click();
  await page
    .getByRole('combobox', { name: 'Filter property' })
    .selectOption({ label: 'Review' });
  await page
    .getByRole('combobox', { name: 'Operator' })
    .selectOption('date-relative');
  await page.getByRole('combobox', { name: 'Value' }).selectOption('today');
  await page
    .getByRole('button', { name: 'Add filter', exact: true })
    .click();
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await expect(
    database.getByRole('button', { name: 'Paper.md', exact: true }),
  ).toBeVisible();
});
