import { expect, test } from '@playwright/test';

test('editor font size uses the shared slider at both endpoints', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Slider acceptance');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await expect(page.getByRole('tab', { name: 'welcome.md' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  const slider = dialog.getByRole('slider', { name: 'Editor font size' });
  const track = dialog.locator('[data-range-track]');
  const fill = dialog.locator('[data-range-fill]');
  await expect
    .poll(async () => (await slider.boundingBox())?.width ?? 0)
    .toBe(190);

  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveValue('11');
  await expect
    .poll(() =>
      fill.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(0);
  await page.keyboard.press('End');
  await expect(slider).toHaveValue('24');
  await expect
    .poll(async () => {
      const [trackBox, fillBox] = await Promise.all([
        track.boundingBox(),
        fill.boundingBox(),
      ]);
      return Math.abs((trackBox?.width ?? 0) - (fillBox?.width ?? 0));
    })
    .toBeLessThan(1);
  await page.screenshot({
    path: test.info().outputPath('settings-slider-max.png'),
    animations: 'disabled',
  });
});

for (const touch of [false, true]) {
  test(`settings: reachable controls, keyboard navigation and nested dismissal (${touch ? 'touch' : 'mouse'})`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: touch
        ? { width: 820, height: 1180 }
        : { width: 1440, height: 900 },
      hasTouch: touch,
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.addInitScript(() =>
        Object.defineProperty(window, 'showDirectoryPicker', {
          value: undefined,
          configurable: true,
        }),
      );
      await page.goto(testInfo.project.use.baseURL ?? 'http://localhost:5198');
      await page.getByTestId('create-vault-button').click();
      await page
        .getByTestId('create-vault-name-input')
        .fill('Settings acceptance');
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      await expect(page.getByRole('tab', { name: 'welcome.md' })).toBeVisible();
      const open = page.getByRole('button', { name: 'Settings', exact: true });
      if (touch) await open.tap();
      else await open.click();
      const dialog = page.getByRole('dialog', {
        name: 'Settings',
        exact: true,
      });
      const search = dialog.getByRole('textbox', { name: 'Search settings' });
      const close = dialog.getByRole('button', { name: 'Close settings' });
      await expect(touch ? close : search).toBeFocused();
      await expect(
        dialog.getByRole('combobox', { name: 'Base theme' }),
      ).toBeVisible();
      if (touch) {
        for (const control of [
          close,
          search,
          dialog.getByRole('option', { name: 'Appearance', exact: true }),
        ]) {
          await expect
            .poll(async () => (await control.boundingBox())?.height ?? 0)
            .toBeGreaterThanOrEqual(44);
        }
      }
      const appearance = dialog.getByRole('option', {
        name: 'Appearance',
        exact: true,
      });
      await appearance.focus();
      await page.keyboard.press('ArrowDown');
      await expect(
        dialog.getByRole('option', { name: 'Editor', exact: true }),
      ).toBeFocused();
      await expect(
        dialog.getByRole('combobox', { name: 'Default view mode' }),
      ).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(close).toBeFocused();
      await search.fill('zz-no-match');
      await expect(
        dialog.getByText('No settings match', { exact: false }),
      ).toBeVisible();
      await search.fill('');
      await dialog
        .getByRole('option', { name: 'Community plugins', exact: true })
        .click();
      await dialog
        .locator('input[type=file][multiple][accept*=".json"]')
        .setInputFiles([
          {
            name: 'manifest.json',
            mimeType: 'application/json',
            buffer: Buffer.from(
              JSON.stringify({
                manifestVersion: 1,
                id: 'acceptance.settings',
                version: '1.0.0',
                froglightSdk: '^0.1.0',
                permissions: [],
              }),
            ),
          },
          {
            name: 'main.js',
            mimeType: 'text/javascript',
            buffer: Buffer.from('export default function() {}'),
          },
        ]);
      const remove = dialog.getByRole('button', {
        name: 'Remove acceptance.settings',
      });
      await remove.click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(remove).toBeFocused();
      await remove.click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Cancel', exact: true })
        .focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(remove).toBeFocused();
      await expect(
        dialog.getByText('acceptance.settings 1.0.0', { exact: true }),
      ).toBeVisible();
      for (const size of [
        { width: 390, height: 844 },
        { width: 600, height: 800 },
        { width: 1180, height: 820 },
      ]) {
        await page.setViewportSize(size);
        await expect(close).toBeInViewport();
        await page.screenshot({
          path: testInfo.outputPath(`settings-${size.width}.png`),
          animations: 'disabled',
        });
      }
      await dialog
        .getByRole('option', { name: 'Froglight Pro', exact: true })
        .click();
      await expect(dialog).toContainText(
        "Subscriptions aren't available on this host yet.",
      );
      await expect(dialog).not.toContainText('Connect to load');
      await dialog
        .getByRole('option', { name: 'Appearance', exact: true })
        .click();
      await dialog
        .getByRole('combobox', { name: 'Base theme' })
        .selectOption('dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await close.click();
      await expect(dialog).toHaveCount(0);
      await open.click();
      await expect(
        dialog.getByRole('combobox', { name: 'Base theme' }),
      ).toHaveValue('dark');
      await page.screenshot({
        path: testInfo.outputPath('settings-dark.png'),
        animations: 'disabled',
      });
      const editor = page.locator('[contenteditable="true"]');
      const editorBox = touch
        ? null
        : await page.evaluate(() => {
            const element = document.querySelector('[contenteditable="true"]');
            if (!(element instanceof HTMLElement)) return null;
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y };
          });
      await page.keyboard.press('Escape');
      if (!touch) {
        await expect(dialog).toHaveCount(0);
        expect(editorBox).not.toBeNull();
        await page.mouse.click(editorBox!.x + 80, editorBox!.y + 80);
        await page.keyboard.type('Settings focus returned.');
        await expect(editor).toContainText('Settings focus returned.');
        await expect(editor).toBeFocused();
      }
      await expect(dialog).toHaveCount(0);
      if (!touch) {
        await open.click();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await open.click();
        await expect(search).toBeFocused();
        await page.keyboard.type('REOPEN-KEYS');
        await expect(search).toHaveValue('REOPEN-KEYS');
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      if (touch) {
        const bottomSettings = page.locator(
          'button[data-activity="settings"]:visible',
        );
        await bottomSettings.tap();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await bottomSettings.tap();
        await expect(close).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      }
      const newNote = page.getByRole('button', {
        name: 'New note',
        exact: true,
      });
      await newNote.click();
      const picker = page.getByRole('dialog', { name: 'Create a new note' });
      await picker
        .getByRole('textbox', { name: 'Note name' })
        .fill('Cancelled note');
      await picker.getByRole('button', { name: 'Cancel', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(picker).toHaveCount(0);
      await expect(newNote).toBeFocused();
      await expect(
        page.getByRole('tab', { name: /Cancelled note/ }),
      ).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
