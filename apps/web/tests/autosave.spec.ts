import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test('autosaves a real Markdown edit without pressing Save', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Autosave disposable');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await expect(
    page.getByRole('tab', { name: /welcome\.md/ }).first(),
  ).toBeVisible();
  await createFromSidebar(page);
  await page.getByRole('textbox', { name: 'Note name' }).fill('Autosave proof');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Autosave proof.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  const editor = page.locator('.cm-content').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type('Autosave browser proof');
  await expect(editor).toContainText('Autosave browser proof');
  await expect.poll(() => page.evaluate(async () => {
    const vault = await (await navigator.storage.getDirectory())
      .getDirectoryHandle('Autosave disposable');
    return (await (await vault.getFileHandle('Autosave proof.md')).getFile()).text();
  })).toContain('Autosave browser proof');
  await page.reload();
  await page.getByTestId('open-recent-vault-button-0').click();
  await expect(
    page.getByRole('tab', { name: /Autosave proof\.md/ }).first(),
  ).toBeVisible();
  await expect(page.locator('.cm-content').first()).toContainText(
    'Autosave browser proof',
  );
});
