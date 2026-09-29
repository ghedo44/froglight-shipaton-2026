import { createFromSidebar } from './support/sidebar-create.js';
import {
  clickDatabaseAction,
  openDocumentProperties,
} from './support/database-actions.js';
import { expect, test } from '@playwright/test';

test('shared property arrangement and personal pins survive reopening the vault', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Presentation');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Research');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const database = page.getByRole('region', {
    name: 'Research',
    exact: true,
  });
  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  for (const name of ['Status', 'Owner']) {
    await page
      .getByRole('textbox', { name: 'Property name', exact: true })
      .fill(name);
    await page
      .getByRole('dialog', { name: 'View settings' })
      .getByRole('button', { name: 'Add property', exact: true })
      .click();
  }
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
  await openDocumentProperties(page);
  let panel = page.getByRole('tabpanel', { name: 'Properties' });
  await panel.getByText('Arrange properties').click();
  await panel.getByRole('button', { name: 'Move Owner up' }).click();
  await expect(
    panel.getByRole('button', { name: 'Move Owner up' }),
  ).toBeDisabled();
  await panel
    .getByRole('textbox', { name: 'Section' })
    .first()
    .fill('Planning');
  await panel.getByRole('textbox', { name: 'Section' }).first().press('Tab');
  await expect(panel.getByText('Planning', { exact: true })).toBeVisible();
  const hide = panel.getByLabel('Hide when empty').last();
  await hide.click();
  await expect(hide).toBeChecked();
  await expect(
    panel.getByRole('button', { name: 'Show 1 empty properties' }),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Pin' }).last().click();
  await expect(panel.getByRole('button', { name: 'Unpin' })).toHaveCount(1);

  await page
    .getByRole('button', { name: 'Presentation vault options' })
    .click();
  await page.getByText('Close vault', { exact: true }).click();
  await page.getByRole('button', { name: /Presentation Browser/ }).click();
  await page.getByRole('tab', { name: 'Paper.md' }).click();
  await openDocumentProperties(page);
  panel = page.getByRole('tabpanel', { name: 'Properties' });
  await expect(panel.getByText('Planning', { exact: true })).toBeVisible();
  await expect(panel.getByText('Pinned', { exact: true })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Status' })).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Show 1 empty properties' }),
  ).toHaveCount(0);
  await panel.getByText('Arrange properties').click();
  await expect(
    panel.getByRole('button', { name: 'Move Owner up' }),
  ).toBeDisabled();

  await page.getByRole('tab', { name: 'Research.base' }).click();
  const reopenedDatabase = page.getByRole('region', {
    name: 'Research',
    exact: true,
  });
  await reopenedDatabase
    .getByRole('button', { name: 'Rename file for Paper' })
    .click();
  await reopenedDatabase
    .getByRole('textbox', { name: 'File name for Paper' })
    .fill('Revised paper');
  await reopenedDatabase
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(
    page
      .getByRole('complementary', { name: 'Sidebar' })
      .getByText('Revised paper.md', { exact: true }),
  ).toBeVisible();
  await reopenedDatabase
    .getByRole('button', { name: 'Revised paper.md', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Revised paper.md' }),
  ).toHaveAttribute('aria-selected', 'true');
});
