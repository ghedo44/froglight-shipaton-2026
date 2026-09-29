import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

test('Markdown toolbar keeps block and inline cursor state in a disposable vault', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Markdown toolbar');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await expect(
    page.getByRole('tab', { name: /welcome\.md/ }).first(),
  ).toBeVisible();

  await createFromSidebar(page);
  await page.getByRole('textbox', { name: 'Note name' }).fill('Formatting');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();

  await expect(
    page.getByRole('tab', { name: 'Formatting.md', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  const editor = page.locator('.froglight-markdown-editor .cm-content');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');

  const writingTools = page.getByRole('toolbar', { name: 'Writing tools' });
  await writingTools
    .getByRole('combobox', { name: 'Line style' })
    .selectOption('heading:1');
  await page.keyboard.type('Heading body');
  await expect(editor).toContainText('# Heading body');

  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await writingTools
    .getByRole('button', { name: 'Insert and more' })
    .click();
  await page.getByRole('button', { name: 'Bullet list', exact: true }).click();
  await page.keyboard.type('List body');
  await expect(editor).toContainText('- List body');

  const formatters = [
    { label: 'Bold', markers: '****' },
    { label: 'Italic', markers: '__' },
    { label: 'Inline code', markers: '``' },
  ] as const;
  for (const formatter of formatters) {
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    const action = writingTools.getByRole('button', {
      name: formatter.label,
      exact: true,
    });
    await action.click();
    await expect(action).toHaveAttribute('aria-pressed', 'true');
    await expect(editor).toContainText(formatter.markers);
    await action.click();
    await expect(editor).not.toContainText(formatter.markers);
  }
});
