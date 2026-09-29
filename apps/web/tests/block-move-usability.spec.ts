import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });
test('touch block actions reorder without dragging and preserve undo and saved content', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').tap();
  await page.getByTestId('create-vault-name-input').fill('Block moves');
  await page.getByTestId('choose-vault-location-button').tap();
  await page.getByTestId('confirm-create-vault-button').tap();
  await createFromSidebar(page, 'Block page');
  const create = page.getByRole('dialog', { name: 'Create a new note' });
  await create.getByRole('textbox', { name: 'Note name' }).fill('Reorder');
  await create.getByRole('button', { name: 'Create', exact: true }).tap();
  const editor = page.locator('.ProseMirror');
  await editor.fill('First paragraph');
  await editor.press('Enter');
  await page.keyboard.type('Second paragraph');
  await editor.locator('p').last().tap();
  const handle = page.getByRole('button', {
    name: 'Block actions',
    exact: true,
  });
  await handle.tap();
  const menu = page.getByRole('listbox', {
    name: 'Block actions',
    exact: true,
  });
  await menu
    .getByRole('option', { name: 'Move up', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath('move-actions-tablet.png'),
    animations: 'disabled',
  });
  await menu.getByRole('option', { name: 'Move up', exact: true }).tap();
  await expect(editor.locator('p')).toHaveText([
    'Second paragraph',
    'First paragraph',
  ]);
  await page.getByRole('button', { name: 'Undo', exact: true }).tap();
  await expect(editor.locator('p')).toHaveText([
    'First paragraph',
    'Second paragraph',
  ]);
  await page.getByRole('button', { name: 'Redo', exact: true }).tap();
  await expect(editor.locator('p')).toHaveText([
    'Second paragraph',
    'First paragraph',
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.locator('p').first().tap();
  await handle.tap();
  await expect(
    menu.getByRole('option', { name: 'Move up', exact: true }),
  ).toHaveCount(0);
  await menu.getByRole('option', { name: 'Move down', exact: true }).tap();
  await expect(editor.locator('p')).toHaveText([
    'First paragraph',
    'Second paragraph',
  ]);
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Block moves Browser/ }).tap();
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).tap();
  await page
    .getByRole('button', { name: 'Reorder.blockpage', exact: true })
    .tap();
  await expect(editor.locator('p')).toHaveText([
    'First paragraph',
    'Second paragraph',
  ]);
});
