import { createFromSidebar } from './support/sidebar-create.js';
import {
  clickDatabaseAction,
  openDocumentProperties,
} from './support/database-actions.js';
import { expect, test } from '@playwright/test';

test('one document keeps same-named fields from two databases independent', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Two schemas');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  for (const name of ['Research', 'Projects']) {
    await createFromSidebar(page, 'Database');
    await page.getByRole('textbox', { name: 'Note name' }).fill(name);
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    const database = page.getByRole('region', { name, exact: true });
    await clickDatabaseAction(database, 'View settings');
    await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Property name', exact: true })
      .fill('Status');
    await page
      .getByRole('dialog', { name: 'View settings' })
      .getByRole('button', { name: 'Add property', exact: true })
      .click();
    await page.getByRole('button', { name: 'Close view settings' }).click();
  }

  await page.getByRole('tab', { name: 'Research.base' }).click();
  const research = page.getByRole('region', { name: 'Research', exact: true });
  await research.getByRole('button', { name: 'New item', exact: true }).click();
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
  await panel
    .getByRole('combobox', { name: 'Add to database' })
    .selectOption({ label: 'Projects' });
  await page.getByRole('tab', { name: 'Projects.base' }).click();
  await page.getByRole('tab', { name: 'Paper.md' }).click();
  await openDocumentProperties(page);
  await panel
    .getByRole('combobox', { name: 'Add to database' })
    .selectOption({ label: 'Projects' });
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(panel.getByText('Add database member completed.')).toBeVisible();
  await page.getByRole('tab', { name: 'Projects.base' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Projects', exact: true })
      .getByRole('button', { name: 'Paper.md', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Paper.md' }).click();
  await openDocumentProperties(page);

  const section = (name: string) =>
    panel
      .locator('section')
      .filter({ has: page.getByRole('heading', { name, exact: true }) })
      .first();
  await expect(
    section('Projects').getByRole('textbox', { name: 'Status' }),
  ).toBeVisible();
  await section('Research')
    .getByRole('textbox', { name: 'Status' })
    .fill('Draft');
  await section('Research')
    .getByRole('textbox', { name: 'Status' })
    .press('Tab');
  await section('Projects')
    .getByRole('textbox', { name: 'Status' })
    .fill('Active');
  await section('Projects')
    .getByRole('textbox', { name: 'Status' })
    .press('Tab');
  await expect(
    section('Research').getByRole('textbox', { name: 'Status' }),
  ).toHaveValue('Draft');
  await expect(
    section('Projects').getByRole('textbox', { name: 'Status' }),
  ).toHaveValue('Active');

  await page.getByRole('button', { name: 'Two schemas vault options' }).click();
  await page.getByText('Close vault', { exact: true }).click();
  await page.getByRole('button', { name: /Two schemas Browser/ }).click();
  await page.getByRole('tab', { name: 'Paper.md' }).click();
  await openDocumentProperties(page);
  await expect(
    section('Research').getByRole('textbox', { name: 'Status' }),
  ).toHaveValue('Draft');
  await expect(
    section('Projects').getByRole('textbox', { name: 'Status' }),
  ).toHaveValue('Active');

  await page
    .getByRole('complementary', { name: 'Sidebar' })
    .locator('[data-path="Paper.md"]')
    .hover();
  await page.getByRole('button', { name: 'Paper.md options' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.getByRole('tab', { name: 'Paper (1).md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(panel.getByText('No database properties yet.')).toBeVisible();
  await page.getByRole('tab', { name: 'Paper.md' }).click();
  await openDocumentProperties(page);
  await expect(
    section('Research').getByRole('textbox', { name: 'Status' }),
  ).toHaveValue('Draft');
  await expect(
    section('Projects').getByRole('textbox', { name: 'Status' }),
  ).toHaveValue('Active');
});
