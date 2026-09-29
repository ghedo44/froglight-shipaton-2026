import { createFromSidebar } from './support/sidebar-create.js';
import { clickDatabaseAction } from './support/database-actions.js';
import { expect, test } from '@playwright/test';

test('bulk edit reports a stale row, retries only failures, and undoes committed rows', async ({
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
  await page
    .getByTestId('create-vault-name-input')
    .fill('Bulk edit acceptance');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('People');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const database = page.getByRole('region', { name: 'People', exact: true });

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
    await page.getByRole('tab', { name: 'People.base' }).click();
  }

  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Property name', exact: true })
    .fill('Owner');
  await page
    .getByRole('dialog', { name: 'View settings' })
    .getByRole('button', { name: 'Add property', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'View settings' })
    .getByRole('button', { name: 'Close view settings' })
    .click();

  await database.getByText('Bulk selection', { exact: true }).click();
  await database
    .getByRole('combobox', { name: 'Selection scope' })
    .selectOption('all');
  await database.getByRole('button', { name: 'Select scope' }).click();
  await expect(
    database.getByText('2 selected in current results', { exact: true }),
  ).toBeVisible();
  await database.getByRole('button', { name: 'Bulk edit…' }).click();

  const bulk = database.getByRole('dialog', { name: 'Bulk edit 2 resources' });
  await bulk.getByRole('textbox', { name: 'Owner' }).fill('Team');
  await bulk.getByRole('textbox', { name: 'Owner' }).press('Tab');
  await expect(bulk.getByText(/2 will change/)).toBeVisible();

  const beta = database.getByRole('row', { name: /Beta/ });
  await beta.getByRole('button', { name: /Edit Owner:/ }).click();
  await beta.getByRole('textbox', { name: 'Owner' }).fill('External');
  await beta.getByRole('textbox', { name: 'Owner' }).press('Enter');
  await expect(
    beta.getByRole('button', { name: 'Edit Owner: External' }),
  ).toBeVisible();

  await bulk.getByRole('checkbox', { name: /Apply this value/ }).check();
  await bulk.getByRole('button', { name: 'Apply bulk edit' }).click();
  await expect(bulk.getByText('1 committed · 1 failed')).toBeVisible();
  await expect(bulk.getByRole('alert')).toContainText('Beta');
  await expect(bulk.getByRole('alert')).toContainText(
    'Property changed elsewhere. Refresh and retry.',
  );
  await expect(
    database
      .getByRole('row', { name: /Alpha/ })
      .getByRole('button', { name: 'Edit Owner: Team' }),
  ).toBeVisible();

  await bulk.getByRole('button', { name: 'Retry failed resources' }).click();
  await expect(bulk.getByText('1 committed · 1 failed')).toBeVisible();
  await expect(
    beta.getByRole('button', { name: 'Edit Owner: External' }),
  ).toBeVisible();

  await bulk.getByRole('button', { name: 'Undo committed changes' }).click();
  await expect(bulk.getByText('1 reverted · 0 undo failures')).toBeVisible();
  await expect(
    database
      .getByRole('row', { name: /Alpha/ })
      .getByRole('button', { name: 'Edit Owner: —' }),
  ).toBeVisible();
  await expect(
    beta.getByRole('button', { name: 'Edit Owner: External' }),
  ).toBeVisible();
});
