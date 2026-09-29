import { createFromSidebar } from './support/sidebar-create.js';
import { clickDatabaseAction } from './support/database-actions.js';
import { expect, test } from '@playwright/test';

test('table clipboard preflights, applies, and copies a bounded rectangle', async ({
  context,
  page,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page
    .getByTestId('create-vault-name-input')
    .fill('Clipboard acceptance');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Research');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const database = page.getByRole('region', { name: 'Research', exact: true });

  for (const name of ['Alpha', 'Beta']) {
    await database
      .getByRole('button', { name: 'New item', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('textbox', { name: 'Note name' })
      .fill(name);
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    await expect(page.getByRole('tab', { name: `${name}.md` })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('tab', { name: 'Research.base' }).click();
    await expect(
      page.getByRole('tab', { name: 'Research.base' }),
    ).toHaveAttribute('aria-selected', 'true');
  }

  await expect(
    database.getByRole('button', { name: 'Beta.md', exact: true }),
  ).toBeVisible();

  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Property name', exact: true })
    .fill('Topic');
  await page
    .getByRole('dialog', { name: 'View settings' })
    .getByRole('button', { name: 'Add property', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'View settings' })
    .getByRole('button', { name: 'Close view settings' })
    .click();

  await database.getByText('Bulk selection', { exact: true }).click();
  await database.getByRole('button', { name: 'Select scope' }).click();
  await expect(
    database.getByText(
      'Clipboard scope: 2 rows × 1 visible property column. Values only; Name is not included.',
    ),
  ).toBeVisible();
  await page.evaluate(() =>
    navigator.clipboard.writeText('Physics\nChemistry'),
  );
  await database.getByRole('button', { name: 'Paste cells…' }).click();
  const preview = database.getByRole('dialog', { name: 'Paste preview' });
  await expect(
    preview.getByText('2 will change · 0 unchanged · 0 rejected'),
  ).toBeVisible();
  await preview
    .getByRole('checkbox', { name: /Apply the 2 valid changed cells/ })
    .check();
  await preview.getByRole('button', { name: 'Apply 2 cells' }).click();
  await expect(
    preview.getByText('2 committed · 0 write failures'),
  ).toBeVisible();
  await expect(
    database
      .getByRole('row', { name: /Alpha/ })
      .getByRole('button', { name: 'Edit Topic: Physics' }),
  ).toBeVisible();
  await expect(
    database
      .getByRole('row', { name: /Beta/ })
      .getByRole('button', { name: 'Edit Topic: Chemistry' }),
  ).toBeVisible();

  await preview.getByRole('button', { name: 'Close' }).click();
  const copy = database.getByRole('button', { name: 'Copy cells' });
  await copy.click();
  await expect(copy).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('Physics\nChemistry');
});
