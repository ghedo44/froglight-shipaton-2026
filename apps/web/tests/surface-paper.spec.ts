import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

test('Ink and Whiteboard paper changes render and survive reopening', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Paper check');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  for (const [kind, name, extension] of [
    ['Ink page', 'Sketch', 'ink'],
    ['Whiteboard', 'Board', 'whiteboard'],
  ]) {
    await createFromSidebar(page, kind);
    await page.getByRole('textbox', { name: 'Note name' }).fill(name);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    await expect(
      page.getByRole('tab', { name: `${name}.${extension}`, exact: true }),
    ).toBeVisible();
    const sidebar = page.getByRole('complementary', {
      name: 'Document sidebar',
    });
    if (!(await sidebar.isVisible())) {
      await page
        .getByRole('button', { name: 'Toggle document sidebar' })
        .click();
    }
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
    const panel = page.locator('[data-inspector-section="canvas"]');
    if (extension === 'ink') {
      await expect(
        panel.getByRole('combobox', { name: 'Canvas mode' }),
      ).toHaveCount(0);
    } else {
      await expect(panel.getByText('Infinite canvas', { exact: true }).first()).toBeVisible();
    }
    const template = panel.getByRole('combobox', { name: 'Page paper' });
    await expect(template).toHaveValue('froglight.dots');
    if (extension === 'whiteboard') {
      await page.screenshot({
        path: test.info().outputPath('whiteboard-default-paper.png'),
        animations: 'disabled',
      });
    }
    await template.selectOption('froglight.grid');
    const spacing = panel.getByRole('spinbutton', { name: 'Rule spacing' });
    await spacing.fill('40');
    await spacing.press('Tab');
    await panel.getByRole('button', { name: 'Paper color: #faf7ef' }).click();
    await expect
      .poll(() =>
        page.locator('.fl-ink-canvas').evaluate((canvas: HTMLCanvasElement) => {
          const context = canvas.getContext('2d');
          if (context === null) return [0, 0, 0];
          const pixel = context.getImageData(
            Math.floor(canvas.width / 2) + 3,
            Math.floor(canvas.height / 2) + 3,
            1,
            1,
          ).data;
          return [pixel[0], pixel[1], pixel[2]];
        }),
      )
      .toEqual([250, 247, 239]);
    await page.screenshot({
      path: test.info().outputPath(`${extension}-paper.png`),
      animations: 'disabled',
    });
    if (extension === 'ink') {
      const coloredPixels = () =>
        page.locator('.fl-ink-canvas').evaluate((canvas: HTMLCanvasElement) => {
          const context = canvas.getContext('2d');
          if (context === null) return 0;
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          let count = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            if (
              pixels[index] === 250 &&
              pixels[index + 1] === 247 &&
              pixels[index + 2] === 239
            )
              count++;
          }
          return count;
        });
      const beforePan = await coloredPixels();
      const bounds = await page.locator('.fl-ink-canvas').boundingBox();
      if (bounds === null) throw new Error('Ink canvas has no bounds');
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await page.mouse.wheel(1500, 1500);
      await expect.poll(coloredPixels).toBeGreaterThan(beforePan * 0.67);
      await expect.poll(coloredPixels).toBeLessThan(beforePan * 0.75);
    }
    await page.keyboard.press('Control+s');
    await expect(
      page.getByText('Saved locally', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Toggle document sidebar' }).click();
  }

  await page.reload();
  await page.getByRole('button', { name: /Paper check Browser/ }).click();
  for (const name of ['Sketch.ink', 'Board.whiteboard']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: 'Toggle document sidebar' }).click();
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
    const panel = page.locator('[data-inspector-section="canvas"]');
    await expect(
      panel.getByRole('combobox', { name: 'Page paper' }),
    ).toHaveValue('froglight.grid');
    await expect(
      panel.getByRole('spinbutton', { name: 'Rule spacing' }),
    ).toHaveValue('40');
    await page.getByRole('button', { name: 'Toggle document sidebar' }).click();
  }
});
