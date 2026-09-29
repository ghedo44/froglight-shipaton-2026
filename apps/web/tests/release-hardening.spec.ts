import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

// Production providers and disposable OPFS vaults. Browser touch emulation does
// not certify a physical keyboard, stylus, or iOS device.
for (const width of [390, 820, 1280]) {
  test(`fresh ${width}px workspace keeps editing and drawers reachable`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      hasTouch: width < 1280,
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
      await page.goto(
        test.info().project.use.baseURL ?? 'http://localhost:5198',
      );
      await page.getByTestId('create-vault-button').click();
      await page
        .getByTestId('create-vault-name-input')
        .fill(`Hardening ${width}`);
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      await expect(
        page.getByRole('tab', { name: /welcome\.md/ }).first(),
      ).toBeVisible();
      await createFromSidebar(page, 'Block page');
      await page.getByRole('textbox', { name: 'Note name' }).fill('Writing');
      await page
        .getByRole('dialog', { name: 'Create a new note' })
        .getByRole('button', { name: 'Create', exact: true })
        .click();
      const editor = page.locator('.flbp-host .ProseMirror');
      await editor.click();
      await page.keyboard.type('Selection survives toolbar activation.');
      await page.keyboard.press('Control+a');
      if (width === 1280) {
        const sidebar = page.getByRole('button', { name: 'Toggle sidebar' });
        await page.keyboard.press('Control+b');
        await expect(editor.locator('strong')).toHaveText(
          'Selection survives toolbar activation.',
        );
        await expect(sidebar).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Control+b');
        await expect(editor.locator('strong')).toHaveCount(0);
        // With focus outside the editor, the same shell shortcut remains usable.
        await sidebar.focus();
        await page.keyboard.press('Control+b');
        await expect(sidebar).toHaveAttribute('aria-expanded', 'false');
        await page.keyboard.press('Control+b');
        await expect(sidebar).toHaveAttribute('aria-expanded', 'true');
        await editor.focus();
        await page.keyboard.press('Control+a');
      }
      await page.getByRole('button', { name: 'Style', exact: true }).click();
      await page.getByRole('button', { name: 'Bold', exact: true }).click();
      await expect(editor.locator('strong')).toHaveText(
        'Selection survives toolbar activation.',
      );
      await expect(editor).toBeFocused();
      await page.keyboard.press('Control+s');
      await page
        .getByRole('tab', { name: /welcome\.md/ })
        .first()
        .click();
      await page
        .getByRole('tab', { name: /Writing\.blockpage/ })
        .first()
        .click();
      await expect(editor.locator('strong')).toHaveText(
        'Selection survives toolbar activation.',
      );
      await page.getByRole('button', { name: 'View', exact: true }).click();
      await expect(
        page.locator('.flbp-host [contenteditable="true"]'),
      ).toHaveCount(0);
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(editor).toHaveAttribute('contenteditable', 'true');
      if (width === 1280) {
        await page
          .getByRole('button', { name: 'Split right', exact: true })
          .click();
        await createFromSidebar(page, 'Block page');
        await page.getByRole('textbox', { name: 'Note name' }).fill('Right');
        await page
          .getByRole('dialog', { name: 'Create a new note' })
          .getByRole('button', { name: 'Create', exact: true })
          .click();
        await expect(page.locator('.flbp-host .ProseMirror')).toHaveCount(2);
        const strips = page.locator('[data-toolbar="category-strip"]');
        await expect(strips).toHaveCount(2);
        for (let index = 0; index < 2; index += 1) {
          await expect(strips.nth(index)).toHaveAttribute(
            'data-compact',
            'true',
          );
          const overlappingLabels = await strips
            .nth(index)
            .evaluate((strip) => {
              const boxes = [...strip.querySelectorAll('button')].map(
                (button) => button.getBoundingClientRect(),
              );
              return boxes.some((box, boxIndex) =>
                boxes
                  .slice(boxIndex + 1)
                  .some(
                    (other) =>
                      box.left < other.right &&
                      other.left < box.right &&
                      box.top < other.bottom &&
                      other.top < box.bottom,
                  ),
              );
            });
          expect(overlappingLabels).toBe(false);
        }
        const leftPane = strips
          .nth(0)
          .locator('xpath=ancestor::*[@data-pane][1]');
        const rightPane = strips
          .nth(1)
          .locator('xpath=ancestor::*[@data-pane][1]');
        const leftMore = strips
          .nth(0)
          .getByRole('button', { name: 'More tool categories' });
        await strips
          .nth(1)
          .getByRole('button', { name: 'Style', exact: true })
          .click();
        await leftMore.click();
        await expect(leftPane.locator('[data-tool-shelf]')).toBeHidden();
        await expect(rightPane.locator('[data-tool-shelf]')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(rightPane.locator('[data-tool-shelf]')).toBeVisible();
      }
      expect(errors).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath(`workspace-${width}.png`),
      });
    } finally {
      await context.close();
    }
  });
}

test('compact category More uses the pane layer and temporarily clears its shelf', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 900 },
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await page.addInitScript(() =>
      Object.defineProperty(window, 'showDirectoryPicker', {
        value: undefined,
        configurable: true,
      }),
    );
    await page.goto(test.info().project.use.baseURL ?? 'http://localhost:5198');
    await page.getByTestId('create-vault-button').click();
    await page.getByTestId('create-vault-name-input').fill('Compact toolbar');
    await page.getByTestId('choose-vault-location-button').click();
    await page.getByTestId('confirm-create-vault-button').click();
    await createFromSidebar(page, 'Ink page');
    await page.getByRole('textbox', { name: 'Note name' }).fill('Writing');
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();

    await expect(page.locator('.fl-ink-canvas')).toBeVisible();
    const writingTab = page.getByRole('tab', {
      name: 'Writing.ink',
      exact: true,
    });
    await writingTab.click({ button: 'right' });
    const tabMenu = page.getByRole('menu');
    await expect(tabMenu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(tabMenu).toHaveCount(0);
    await expect(writingTab).toBeFocused();
    const strip = page.locator('[data-toolbar="category-strip"]');
    await expect(strip).toHaveAttribute('data-compact', 'true');
    expect(
      await strip.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    expect(
      await strip.evaluate((node) => {
        const boxes = [...node.querySelectorAll('button')].map((button) =>
          button.getBoundingClientRect(),
        );
        const contentLeft = Math.min(...boxes.map((box) => box.left));
        const contentRight = Math.max(...boxes.map((box) => box.right));
        const stripBox = node.getBoundingClientRect();
        return (
          Math.abs(
            (contentLeft + contentRight) / 2 -
              (stripBox.left + stripBox.right) / 2,
          ) <= 1
        );
      }),
    ).toBe(true);
    const more = strip.getByRole('button', { name: 'More tool categories' });
    const pen = strip.getByRole('button', { name: 'Pen' });
    const writeShelf = page.locator('[data-tool-shelf="surface.write"]');
    await expect(writeShelf).toBeVisible();
    await pen.click();
    await expect(writeShelf).toBeHidden();
    await pen.click();
    await expect(writeShelf).toBeVisible();
    await expect(pen).toHaveAttribute('aria-expanded', 'true');
    await pen.click();
    await expect(writeShelf).toBeHidden();
    await expect(pen).toHaveAttribute('aria-expanded', 'false');
    await pen.click();
    await expect(writeShelf).toBeVisible();
    const penSettings = writeShelf.getByRole('button', {
      name: 'Pen',
      exact: true,
    });
    await penSettings.click();
    await page.keyboard.press('Escape');
    await expect(writeShelf).toBeVisible();

    await more.click();
    const menu = page.getByRole('menu', { name: 'More tool categories' });
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('Shapes');
    expect(
      await menu.evaluate((node) =>
        node.parentElement?.hasAttribute('data-popover-layer'),
      ),
    ).toBe(true);
    await expect(page.locator('[data-tool-shelf]')).toBeHidden();
    await page.screenshot({
      path: test.info().outputPath('compact-more-390.png'),
    });

    await menu.getByRole('menuitem', { name: 'Shapes' }).click();
    await expect(menu).toBeHidden();
    await expect(
      page.locator('[data-tool-shelf="surface.shapes"]'),
    ).toBeVisible();

    await more.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
    await expect(
      page.locator('[data-tool-shelf="surface.shapes"]'),
    ).toBeVisible();
    await strip.getByRole('button', { name: 'Shapes' }).click();
    await expect(
      page.locator('[data-tool-shelf="surface.shapes"]'),
    ).toBeHidden();
  } finally {
    await context.close();
  }
});
