import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test('downloads a full vault backup and restores it into a new empty vault', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Backup source');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  await createFromSidebar(page);
  await page.getByRole('textbox', { name: 'Note name' }).fill('Kept note');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await page.keyboard.press('Control+s');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('option', { name: 'Backups', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await settings.getByRole('button', { name: 'Download backup' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    'Backup source.froglight-vault.json',
  );
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const backup = Buffer.concat(chunks);
  expect(JSON.parse(backup.toString('utf8'))).toMatchObject({
    format: 'froglight.vault-backup',
    version: 1,
  });
  await expect(settings.getByRole('status')).toContainText('Backup ready:');
  await settings.getByRole('button', { name: 'Close settings' }).click();

  await page
    .getByRole('button', { name: 'Backup source vault options' })
    .click();
  await page.getByText('Close vault', { exact: true }).click();
  await expect(page.getByTestId('vault-launcher')).toBeVisible();

  await page.getByTestId('restore-vault-file-input').setInputFiles({
    name: 'Backup source.froglight-vault.json',
    mimeType: 'application/json',
    buffer: backup,
  });
  const restore = page.getByRole('dialog', { name: 'Restore backup' });
  const confirm = restore.getByRole('checkbox', {
    name: /Create a new empty vault/,
  });
  const submit = restore.getByRole('button', {
    name: 'Restore into new vault',
  });
  await expect(submit).toBeDisabled();
  await restore
    .getByRole('textbox', { name: 'New vault name' })
    .fill('Restored acceptance');
  await confirm.check();
  await submit.click();

  await expect(
    page.getByRole('button', {
      name: 'Restored acceptance vault options',
    }),
  ).toBeVisible();
  await expect(page.getByText('Kept note.md', { exact: true })).toBeVisible();
});

test('rejects an unsupported backup without opening or replacing a vault', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('restore-vault-file-input').setInputFiles({
    name: 'Future.froglight-vault.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'froglight.vault-backup',
        version: 99,
        directories: [],
        files: [],
      }),
    ),
  });
  const restore = page.getByRole('dialog', { name: 'Restore backup' });
  await restore
    .getByRole('checkbox', { name: /Create a new empty vault/ })
    .check();
  await restore.getByRole('button', { name: 'Restore into new vault' }).click();
  await expect(restore.getByRole('alert')).toContainText(
    'Unsupported vault backup format/version',
  );
  await expect(page.getByTestId('vault-launcher')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry opening' })).toHaveCount(
    0,
  );
});
