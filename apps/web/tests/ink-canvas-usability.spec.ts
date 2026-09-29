import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
test('Ink canvas dimensions stay reachable without covering zoom and persist', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Ink canvas');
  await page.getByTestId('choose-vault-location-button').tap();
  await page.getByTestId('confirm-create-vault-button').tap();
  await page.locator('[data-activity="new-note"]').tap();
  const create = page.getByRole('dialog', { name: 'Create a new note' });
  await create.getByRole('textbox', { name: 'Note name' }).fill('Canvas');
  await create.getByRole('radio', { name: /Ink page/ }).check();
  await create.getByRole('button', { name: 'Create', exact: true }).tap();
  await expect(
    page.getByRole('tab', { name: 'Canvas.ink', exact: true }),
  ).toBeVisible();
  const resizeHandlePixels = () =>
    page.locator('.fl-ink-canvas').evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d');
      if (context === null) return 0;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index] ?? 0;
        const green = pixels[index + 1] ?? 0;
        const blue = pixels[index + 2] ?? 0;
        if (red > 80 && blue > 140 && blue - green > 30) count += 1;
      }
      return count;
    });
  await expect.poll(resizeHandlePixels).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'View', exact: true }).tap();
  await expect.poll(resizeHandlePixels).toBe(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).tap();
  await expect.poll(resizeHandlePixels).toBeGreaterThan(0);
  await page
    .getByRole('button', { name: 'More tool categories', exact: true })
    .tap();
  await page.getByRole('menuitem', { name: 'Canvas', exact: true }).tap();
  const width = page.getByRole('spinbutton', {
    name: 'Canvas width',
    exact: true,
  });
  if (!(await width.isVisible()))
    await page.getByRole('button', { name: 'More tools', exact: true }).tap();
  await expect(width).toBeInViewport();
  await width.fill('900');
  await width.press('Enter');
  await expect(width).toHaveValue('900');
  await expect(
    page.getByRole('button', { name: 'Fit canvas', exact: true }),
  ).toBeInViewport();
  await expect(page.locator('[data-anchor="float.bottom-left"]')).toHaveCount(
    0,
  );
  await page.screenshot({
    path: test.info().outputPath('canvas-phone.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  // Mouse input in a touch-enabled viewport; this does not certify a pen.
  await page.mouse.move(140, 430);
  await page.mouse.down();
  await page.mouse.move(250, 470, { steps: 12 });
  await page.mouse.up();
  const exportButton = page.getByRole('button', {
    name: 'Export PNG',
    exact: true,
  });
  if (!(await exportButton.isVisible()))
    await page.getByRole('button', { name: 'More tools', exact: true }).tap();
  const downloadPending = page.waitForEvent('download');
  await exportButton.tap();
  const download = await downloadPending;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const exportPath = test.info().outputPath('exported-canvas.png');
  await download.saveAs(exportPath);
  const png = await readFile(exportPath);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(1800);
  expect(png.readUInt32BE(20)).toBe(1200);
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Ink canvas Browser/ }).tap();
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).tap();
  await page.getByRole('button', { name: 'Canvas.ink', exact: true }).tap();
  await page
    .getByRole('button', { name: 'More tool categories', exact: true })
    .tap();
  await page.getByRole('menuitem', { name: 'Canvas', exact: true }).tap();
  if (!(await width.isVisible()))
    await page.getByRole('button', { name: 'More tools', exact: true }).tap();
  await expect(width).toHaveValue('900');
});
