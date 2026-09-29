import { expect, test } from '@playwright/test';

test.use({ hasTouch: true, viewport: { width: 820, height: 1180 } });

test('Block Page touch formatting appears only with the keyboard', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('open-recent-vault-button-0').click();
  const editor = page.locator('.flbp-host .ProseMirror').first();
  await expect(editor).toBeVisible();
  const paragraph = editor.locator('p').first();
  const toolbar = page.locator(
    '[data-selection-toolbar-kind="froglight.blockpage"] [data-anchor="float.selection"]',
  );
  await paragraph.tap();
  await expect(toolbar).toBeHidden();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(toolbar).toBeHidden();

  const keyboardHeight = async (height: number) => {
    await page.evaluate((height) => {
      Object.defineProperty(window.visualViewport!, 'height', {
        configurable: true,
        value: window.innerHeight - height,
      });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    }, height);
  };
  await keyboardHeight(350);
  await expect(toolbar).toBeVisible();
  await expect(
    toolbar.getByRole('button', { name: 'Bold', exact: true }),
  ).toBeVisible();
  const bounds = (await toolbar.boundingBox())!;
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(831);
  await keyboardHeight(0);
  await expect(toolbar).toBeHidden();
  await paragraph.tap();
  await expect(toolbar).toBeHidden();
});

test.describe('mouse', () => {
  test.use({ hasTouch: false });
  test('keeps the desktop text selection toolbar', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('open-recent-vault-button-0').click();
    const editor = page.locator('.flbp-host .ProseMirror').first();
    await expect(editor).toBeVisible();
    await editor.locator('p').first().click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(
      page.locator(
        '[data-selection-toolbar-kind="froglight.blockpage"] [data-anchor="float.selection"]',
      ),
    ).toBeVisible();
  });
});
