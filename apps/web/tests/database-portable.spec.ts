import { createFromSidebar } from './support/sidebar-create.js';
import { clickDatabaseAction } from './support/database-actions.js';
import { expect, test } from '@playwright/test';

test('exports selected dependencies and imports a validated portable copy', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Portable database');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  await createFromSidebar(page);
  await page.getByRole('textbox', { name: 'Note name' }).fill('Dependency');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();

  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Travel');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();

  const database = page.getByRole('region', { name: 'Travel', exact: true });
  await clickDatabaseAction(database, 'Portable copy');
  await database.getByLabel(/Dependency/).check();

  const downloadPromise = page.waitForEvent('download');
  await database
    .getByRole('button', { name: 'Download portable copy' })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Travel.froglight-database.json');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const record = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    format: string;
    documents: Array<{ path: string }>;
  };
  expect(record.format).toBe('froglight.database-portable');
  expect(record.documents).toHaveLength(2);

  const csvPromise = page.waitForEvent('download');
  await database.getByRole('button', { name: 'Download CSV' }).click();
  const csvDownload = await csvPromise;
  expect(csvDownload.suggestedFilename()).toBe('Travel.csv');
  const csvStream = await csvDownload.createReadStream();
  const csvChunks: Buffer[] = [];
  for await (const chunk of csvStream) csvChunks.push(Buffer.from(chunk));
  expect(Buffer.concat(csvChunks).toString('utf8')).toContain(
    '"Resource ID","Title","Kind","Path"',
  );

  for (const document of record.documents)
    document.path = `Imported ${document.path}`;
  await database.getByLabel('Choose bundle').setInputFiles({
    name: 'Travel copy.froglight-database.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
  await expect(
    database.getByText(/2 documents · database at Imported Travel\.base/),
  ).toBeVisible();
  await database
    .getByRole('button', { name: 'Import into this vault' })
    .click();
  await expect(database.getByText(/Imported 2 documents/)).toBeVisible();
  await database
    .getByRole('button', { name: 'Open imported database' })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Imported Travel.base' }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('rejects an unsupported portable bundle before import', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Portable validation');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Records');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const database = page.getByRole('region', { name: 'Records', exact: true });
  await clickDatabaseAction(database, 'Portable copy');
  await database.getByLabel('Choose bundle').setInputFiles({
    name: 'future.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'froglight.database-portable',
        version: 99,
        documents: [],
        externalReferences: [],
      }),
    ),
  });
  await expect(
    database.getByRole('alert').filter({ hasText: 'format or version' }),
  ).toBeVisible();
  await expect(
    database.getByRole('button', { name: 'Import into this vault' }),
  ).toHaveCount(0);
});
