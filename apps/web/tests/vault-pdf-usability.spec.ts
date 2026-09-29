import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Generated three-page PDF: plain text and rectangles at mixed page sizes.
const pdfFixture = fileURLToPath(
  new URL('./fixtures/three-page-source.pdf', import.meta.url),
);

for (const touch of [false, true]) {
  test.describe(touch ? 'tablet touch' : 'desktop mouse', () => {
    test.use({
      hasTouch: touch,
      viewport: touch
        ? { width: 820, height: 1180 }
        : { width: 1440, height: 900 },
    });
    test('PDF import recovers from invalid data, saves selected pages, and vault close returns to launcher', async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() =>
        Object.defineProperty(window, 'showDirectoryPicker', {
          value: undefined,
          configurable: true,
        }),
      );
      await page.goto('/');
      await page.getByTestId('create-vault-button').click();
      await page.getByTestId('create-vault-name-input').fill('PDF lifecycle');
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      if (touch)
        await page
          .getByRole('button', { name: 'Toggle sidebar', exact: true })
          .tap();
      const input = page
        .locator('input[type=file][accept="application/pdf,.pdf"]')
        .first();
      await input.setInputFiles({
        name: 'broken.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('not a PDF'),
      });
      await page
        .getByRole('button', { name: 'Import pages', exact: true })
        .click();
      await expect(page.getByText(/PDF import failed:/)).toBeVisible();
      await expect(page.getByText(/Cannot access private/)).toHaveCount(0);
      await input.setInputFiles(pdfFixture);
      await page
        .getByRole('dialog', { name: 'Choose PDF pages', exact: true })
        .getByRole('textbox')
        .fill('1, 3');
      await page
        .getByRole('button', { name: 'Import pages', exact: true })
        .click();
      await expect(
        page.getByRole('tab', {
          name: 'three-page-source.notebook',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.locator('[data-anchor="float.bottom-left"]'),
      ).toContainText('1 / 2');
      await page
        .getByRole('button', { name: 'Next page', exact: true })
        .click();
      await expect(
        page.locator('[data-anchor="float.bottom-left"]'),
      ).toContainText('2 / 2');
      await page.keyboard.press('Control+s');
      await page.screenshot({
        path: test.info().outputPath('imported-pdf.png'),
        animations: 'disabled',
      });
      if (touch)
        await page
          .getByRole('button', { name: 'Toggle sidebar', exact: true })
          .tap();
      await page
        .getByRole('button', {
          name: 'PDF lifecycle vault options',
          exact: true,
        })
        .click();
      await page.getByText('Close vault', { exact: true }).click();
      await expect(page.getByTestId('create-vault-button')).toBeVisible();
      expect(errors).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath('launcher-after-close.png'),
        animations: 'disabled',
      });
      await page.getByRole('button', { name: /PDF lifecycle Browser/ }).click();
      await expect(
        page.getByRole('tab', {
          name: 'three-page-source.notebook',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.locator('[data-anchor="float.bottom-left"]'),
      ).toContainText('/ 2');
      // A reopened workspace must bind new writes to the real vault too.
      if (touch)
        await page
          .getByRole('button', { name: 'Toggle sidebar', exact: true })
          .tap();
      await createFromSidebar(page, 'Block page');
      const create = page.getByRole('dialog', { name: 'Create a new note' });
      await create
        .getByRole('textbox', { name: 'Note name' })
        .fill('After reopen');
      await create.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(
        page.getByRole('tab', { name: 'After reopen.blockpage', exact: true }),
      ).toBeVisible();
      await page.locator('.ProseMirror').fill('Saved after closing the vault');
      await page.keyboard.press('Control+s');
      await expect(
        page.getByText('Saved locally', { exact: true }),
      ).toBeVisible();
      await page.reload();
      await page.getByRole('button', { name: /PDF lifecycle Browser/ }).click();
      if (touch)
        await page
          .getByRole('button', { name: 'Toggle sidebar', exact: true })
          .tap();
      await page
        .getByRole('button', { name: 'After reopen.blockpage', exact: true })
        .click();
      await expect(page.locator('.ProseMirror')).toContainText(
        'Saved after closing the vault',
      );
      expect(errors).toEqual([]);
    });
  });
}
