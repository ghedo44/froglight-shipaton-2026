import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test('LaTeX source uses a centered writing column', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('LaTeX column');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'LaTeX');
  const dialog = page.getByRole('dialog', { name: 'Create a new note' });
  await dialog.getByRole('textbox', { name: 'Note name' }).fill('Formula');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  for (const width of [1280, 800]) {
    await page.setViewportSize({ width, height: 720 });
    const geometry = await page
      .locator('.froglight-latex-source .cm-content')
      .evaluate((content) => {
        const source = content.closest('.froglight-latex-source');
        if (!source) throw new Error('Missing LaTeX source pane');
        const column = content.getBoundingClientRect();
        const pane = source.getBoundingClientRect();
        return {
          centerOffset: Math.abs(
            (column.left + column.right - pane.left - pane.right) / 2,
          ),
          sideMargin: column.left - pane.left,
        };
      });
    expect(geometry.centerOffset).toBeLessThan(2);
    if (width === 1280) expect(geometry.sideMargin).toBeGreaterThan(40);
  }
});
