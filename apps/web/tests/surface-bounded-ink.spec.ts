import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test, type Page } from '@playwright/test';

async function createInk(page: Page): Promise<void> {
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
    .fill('Bounded ink disposable');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Ink page');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Bounded proof');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.locator('.fl-ink-canvas:visible')).toBeVisible();
}

test('live bounded ink reaches the paper edge without painting beyond it', async ({
  page,
}) => {
  await createInk(page);
  const canvas = page.locator('.fl-ink-canvas:visible');
  const geometry = await canvas.evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2D context unavailable');
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let maxX = -1;
    let minY = canvas.height;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        const red = pixels[index] ?? 0;
        const green = pixels[index + 1] ?? 0;
        const blue = pixels[index + 2] ?? 0;
        if (red > 80 && blue > 140 && blue - green > 30) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX < 0) throw new Error('paper resize chrome not found');
    const rect = canvas.getBoundingClientRect();
    (
      window as unknown as {
        __boundedInkBaseline: Uint8ClampedArray;
      }
    ).__boundedInkBaseline = new Uint8ClampedArray(pixels);
    return {
      page: { minX, maxX, minY, maxY },
      scaleX: canvas.width / rect.width,
      scaleY: canvas.height / rect.height,
      canvasLeft: rect.left,
      canvasTop: rect.top,
    };
  });

  const yPixel = (geometry.page.minY + geometry.page.maxY) / 2 + 70;
  const start = {
    x: geometry.canvasLeft + (geometry.page.maxX - 100) / geometry.scaleX,
    y: geometry.canvasTop + yPixel / geometry.scaleY,
  };
  const outside = {
    x: geometry.canvasLeft + (geometry.page.maxX + 70) / geometry.scaleX,
    y: start.y,
  };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(outside.x, outside.y, { steps: 16 });
  await page.waitForTimeout(32);

  const liveDiff = await canvas.evaluate(
    (node, { edgeX, y }) => {
      const canvas = node as HTMLCanvasElement;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('2D context unavailable');
      const current = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      const baseline = (
        window as unknown as {
          __boundedInkBaseline: Uint8ClampedArray;
        }
      ).__boundedInkBaseline;
      const changed = (x0: number, x1: number): number => {
        let count = 0;
        for (
          let py = Math.max(0, y - 30);
          py <= Math.min(canvas.height - 1, y + 30);
          py += 1
        ) {
          for (
            let px = Math.max(0, x0);
            px <= Math.min(canvas.width - 1, x1);
            px += 1
          ) {
            const index = (py * canvas.width + px) * 4;
            const delta =
              Math.abs((current[index] ?? 0) - (baseline[index] ?? 0)) +
              Math.abs((current[index + 1] ?? 0) - (baseline[index + 1] ?? 0)) +
              Math.abs((current[index + 2] ?? 0) - (baseline[index + 2] ?? 0));
            if (delta > 30) count += 1;
          }
        }
        return count;
      };
      return {
        inside: changed(edgeX - 120, edgeX - 10),
        outside: changed(edgeX + 12, edgeX + 80),
      };
    },
    { edgeX: geometry.page.maxX, y: Math.round(yPixel) },
  );
  expect(liveDiff.inside).toBeGreaterThan(20);
  expect(liveDiff.outside).toBe(0);

  // Re-enter at a separated height during the same physical press.
  await page.mouse.move(outside.x, outside.y + 100, { steps: 4 });
  await page.mouse.move(start.x, start.y + 100, { steps: 16 });
  await page.mouse.up();
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true }),
  ).toBeDisabled();
});
