import { expect, test } from '@playwright/test';

for (const touch of [false, true]) {
  test(`appearance motion overrides the system and survives reload (${touch ? 'touch' : 'mouse'})`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      hasTouch: touch,
      viewport: { width: 1180, height: 820 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    try {
      await page.addInitScript(() =>
        Object.defineProperty(window, 'showDirectoryPicker', {
          value: undefined,
          configurable: true,
        }),
      );
      await page.goto('/');
      await page.getByTestId('create-vault-button').click();
      await page
        .getByTestId('create-vault-name-input')
        .fill('Motion acceptance');
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      await expect(page.getByRole('tab', { name: 'welcome.md' })).toBeVisible();
      const open = page.getByRole('button', { name: 'Settings', exact: true });
      const dialog = page.getByRole('dialog', {
        name: 'Settings',
        exact: true,
      });
      const motion = dialog.getByRole('combobox', {
        name: 'Animations',
        exact: true,
      });
      const animationDuration = () =>
        dialog.evaluate((el) =>
          parseFloat(getComputedStyle(el).animationDuration),
        );
      const openSettings = async () => {
        if (touch) await open.tap();
        else await open.click();
        await expect(dialog).toBeVisible();
      };
      await openSettings();
      await expect(motion).toHaveValue('system');
      expect(await animationDuration()).toBeLessThan(0.001);
      await motion.focus();
      await motion.selectOption('on');
      await expect(motion).toBeFocused();
      expect(await animationDuration()).toBeGreaterThan(0.1);
      await dialog
        .getByRole('combobox', { name: 'Base theme' })
        .selectOption('dark');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await openSettings();
      expect(await animationDuration()).toBeGreaterThan(0.1);
      expect(
        await dialog.evaluate((el) => getComputedStyle(el).animationName),
      ).not.toBe('none');
      await page.screenshot({
        path: testInfo.outputPath('appearance-motion-dark.png'),
      });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await page.reload();
      await page
        .getByRole('button', { name: /^Motion acceptance Browser/ })
        .click();
      await expect(page.getByRole('tab', { name: 'welcome.md' })).toBeVisible();
      await expect(open).toBeVisible();
      await openSettings();
      await expect(motion).toHaveValue('on');
      expect(await animationDuration()).toBeGreaterThan(0.1);
      await motion.selectOption('off');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      expect(await animationDuration()).toBeLessThan(0.001);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await openSettings();
      expect(await animationDuration()).toBeLessThan(0.001);
      await motion.selectOption('system');
      expect(await animationDuration()).toBeGreaterThan(0.1);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(await animationDuration()).toBeLessThan(0.001);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      expect(await animationDuration()).toBeGreaterThan(0.1);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'New note', exact: true }).click();
      const picker = page.getByRole('dialog', { name: 'Create a new note' });
      await expect(picker).toBeVisible();
      expect(
        await picker.evaluate((el) =>
          parseFloat(getComputedStyle(el).animationDuration),
        ),
      ).toBeGreaterThan(0.1);
      await page.keyboard.press('Escape');
      await expect(picker).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}
