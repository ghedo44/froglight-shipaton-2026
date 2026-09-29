import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

test('encrypted Notebook source can be unlocked after cancellation and reopen', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Locked source');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).tap();
  await page
    .locator('input[type=file][accept="application/pdf,.pdf"]')
    .first()
    .setInputFiles(
      fileURLToPath(new URL('./fixtures/locked.pdf', import.meta.url)),
    );
  await page.getByRole('button', { name: 'Import pages', exact: true }).tap();
  await page
    .getByRole('dialog', { name: 'Unlock PDF', exact: true })
    .getByRole('textbox')
    .fill('tablet-test');
  await page
    .getByRole('button', { name: 'Unlock and import', exact: true })
    .tap();
  await expect(
    page.getByRole('tab', { name: 'locked.notebook', exact: true }),
  ).toBeVisible();
  const unlock = page.getByRole('dialog', { name: 'Unlock PDF', exact: true });
  await unlock.getByRole('button', { name: 'Cancel', exact: true }).tap();
  await page
    .getByRole('button', { name: 'Unlock PDF', exact: true })
    .first()
    .tap();
  await unlock.getByRole('textbox').fill('wrong');
  await unlock.getByRole('button', { name: 'Unlock', exact: true }).tap();
  const retry = page.getByRole('dialog', {
    name: 'That password did not unlock the PDF',
    exact: true,
  });
  await retry.getByRole('textbox').fill('tablet-test');
  await retry.getByRole('button', { name: 'Unlock', exact: true }).tap();
  await expect(page.locator('.fl-nb-pdf-base').first()).toContainText(
    'Froglight notebook audit PDF page 1',
  );
  await page.screenshot({
    path: test.info().outputPath('unlocked-source.png'),
    animations: 'disabled',
  });
  await page.reload();
  await page.getByRole('button', { name: /Locked source Browser/ }).click();
  await unlock.getByRole('textbox').fill('tablet-test');
  await unlock.getByRole('button', { name: 'Unlock', exact: true }).tap();
  await expect(page.locator('.fl-nb-pdf-base').first()).toContainText(
    'Froglight notebook audit PDF page 1',
  );
});
