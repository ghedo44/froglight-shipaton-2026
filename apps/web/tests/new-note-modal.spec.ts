import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test('a clicked document type stays selected while moving to Create', async ({
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
  await page.getByTestId('create-vault-name-input').fill('New note picker');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await expect(
    page.getByRole('tab', { name: /welcome\.md/ }).first(),
  ).toBeVisible();

  await createFromSidebar(page);
  const blockPage = page.getByRole('radio', { name: /Block page/ });
  const create = page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true });

  await blockPage.click();
  await expect(blockPage).toBeChecked();

  const createBox = await create.boundingBox();
  if (createBox === null) throw new Error('Create button has no layout box');
  await page.mouse.move(
    createBox.x + createBox.width / 2,
    createBox.y + createBox.height / 2,
    { steps: 12 },
  );

  await expect(blockPage).toBeChecked();
  await create.click();
  await expect(
    page.getByRole('tab', { name: 'Untitled.blockpage', exact: true }),
  ).toBeVisible();
});
