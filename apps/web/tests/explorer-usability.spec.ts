import { expect, test } from '@playwright/test';

for (const width of [390, 820, 1440]) {
  test(`touch file actions remain separate from opening documents at ${width}px`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width, height: 1180 },
      hasTouch: true,
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    try {
      await page.addInitScript(() =>
        Object.defineProperty(window, 'showDirectoryPicker', {
          value: undefined,
          configurable: true,
        }),
      );
      await page.goto(testInfo.project.use.baseURL ?? 'http://localhost:5198');
      await page.getByTestId('create-vault-button').tap();
      await page.getByTestId('create-vault-name-input').fill('File actions');
      await page.getByTestId('choose-vault-location-button').tap();
      await page.getByTestId('confirm-create-vault-button').tap();
      const options = page.getByRole('button', {
        name: 'welcome.md options',
        exact: true,
      });
      await expect(options).toBeAttached();
      const initialContent = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const vault = await root.getDirectoryHandle('File actions');
        const notes = await vault.getDirectoryHandle('notes');
        return (
          await (await notes.getFileHandle('welcome.md')).getFile()
        ).text();
      });
      const sidebar = page.getByRole('button', {
        name: width < 760 ? 'Open sidebar' : 'Toggle sidebar',
        exact: true,
      });
      if (width < 1100) {
        await sidebar.tap();
        await expect(
          page
            .getByRole('complementary', { name: 'Sidebar', exact: true })
            .getByRole('button', { name: 'Close sidebar' }),
        ).toHaveCount(0);
        await page.touchscreen.tap(width - 4, 300);
        await expect(
          page.getByRole('complementary', { name: 'Sidebar', exact: true }),
        ).toBeHidden();
        await sidebar.tap();
      }
      await options.tap();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem').first()).toBeFocused();
      if (width === 1440) {
        await page.keyboard.press('Control+p');
        await expect(menu).toHaveCount(0);
        const switcher = page.getByRole('dialog', {
          name: 'Search workspace',
          exact: true,
        });
        await expect(switcher).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(switcher).toHaveCount(0);
        await expect(options).toBeFocused();
        await options.tap();
        await expect(menu.getByRole('menuitem').first()).toBeFocused();
      }
      await expect(
        page.getByRole('complementary', { name: 'Sidebar', exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`file-menu-${width}.png`),
        animations: 'disabled',
      });
      await menu.getByRole('menuitem', { name: /Rename/ }).tap();
      const rename = page.getByRole('dialog');
      await rename.getByRole('textbox').fill('Cancelled rename.md');
      await rename.getByRole('button', { name: 'Cancel', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(rename).toHaveCount(0);
      await expect(options).toBeFocused();
      await options.tap();
      await menu.getByRole('menuitem', { name: /Delete/ }).tap();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toBeVisible();
      await confirm
        .getByRole('button', { name: 'Cancel', exact: true })
        .focus();
      await page.keyboard.press('Enter');
      await expect(confirm).toHaveCount(0);
      await expect(options).toBeFocused();
      await page
        .getByRole('button', { name: 'notes options', exact: true })
        .tap();
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'notes options', exact: true }),
      ).toBeFocused();
      const content = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const vault = await root.getDirectoryHandle('File actions');
        const notes = await vault.getDirectoryHandle('notes');
        return (
          await (await notes.getFileHandle('welcome.md')).getFile()
        ).text();
      });
      expect(content).toBe(initialContent);
      await options.tap();
      await menu.getByRole('menuitem', { name: /Rename/ }).tap();
      await rename.getByRole('textbox').fill('renamed.md');
      await rename.getByRole('button', { name: 'Save', exact: true }).tap();
      const renamed = page.getByRole('button', {
        name: 'renamed.md options',
        exact: true,
      });
      await expect(renamed).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'renamed.md.md', exact: true }),
      ).toHaveCount(0);
      await renamed.tap();
      await menu.getByRole('menuitem', { name: /Rename/ }).tap();
      await rename.getByRole('textbox').fill('notes/renamed');
      await rename.getByRole('button', { name: 'Save', exact: true }).tap();
      await expect
        .poll(async () =>
          page.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const vault = await root.getDirectoryHandle('File actions');
            const notes = await vault.getDirectoryHandle('notes');
            return Array.fromAsync(notes.keys());
          }),
        )
        .toEqual(['renamed.md']);
      if (width === 1440) {
        const renamedFile = page.getByRole('button', {
          name: 'renamed.md',
          exact: true,
        });
        await renamedFile.click({ button: 'right' });
        await expect(menu.getByRole('menuitem').first()).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
        await expect(renamedFile).toBeFocused();
        await renamedFile.click({ button: 'right' });
        await page.keyboard.press('Control+b');
        await expect(menu).toHaveCount(0);
        await expect(sidebar).toHaveAttribute('aria-expanded', 'false');
        await page.keyboard.press('Control+b');
        await expect(sidebar).toHaveAttribute('aria-expanded', 'true');
      }
      await page.screenshot({
        path: testInfo.outputPath('renamed-and-moved.png'),
        animations: 'disabled',
      });
    } finally {
      await context.close();
    }
  });
}
