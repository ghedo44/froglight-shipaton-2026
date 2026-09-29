import { setDocumentPresentation } from './support/document-presentation.js';
import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test('database title editing uses document semantics and preserves the filename', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Titles');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Research');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const database = page.getByRole('region', { name: 'Research', exact: true });
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
  const databaseTab = page.getByRole('tab', { name: 'Research.base' });
  await databaseTab.click();
  await expect(databaseTab).toHaveAttribute('aria-selected', 'true');
  await setDocumentPresentation(page, 'View');
  await expect(
    database.getByRole('heading', { name: 'Research' }),
  ).toBeVisible();
  await expect(
    database.getByRole('button', { name: 'Rename Research' }),
  ).toHaveCount(0);
  await setDocumentPresentation(page, 'Edit');
  await expect(
    database.getByRole('button', { name: 'Rename Research' }),
  ).toBeVisible();
  const titleStyle = await database
    .getByRole('button', { name: 'Rename Research' })
    .evaluate((element) => ({
      border: getComputedStyle(element).borderTopWidth,
      background: getComputedStyle(element).backgroundColor,
    }));
  expect(titleStyle.border).toBe('0px');
  expect(
    await database
      .getByRole('button', { name: 'Rename Research' })
      .evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
  ).toBe('6px');
  expect(titleStyle.background).toBe('rgba(0, 0, 0, 0)');

  await database
    .getByRole('button', { name: 'Edit document title for Paper' })
    .click();
  await database
    .getByRole('textbox', { name: 'Document title for Paper' })
    .fill('Catalog paper');
  await database.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(
    database.getByRole('button', { name: 'Catalog paper', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('complementary', { name: 'Sidebar' })
      .getByText('Paper.md', { exact: true }),
  ).toBeVisible();
  await database
    .getByRole('button', { name: 'Catalog paper', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Paper.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.cm-content')).toContainText(
    'title: "Catalog paper"',
  );
});
