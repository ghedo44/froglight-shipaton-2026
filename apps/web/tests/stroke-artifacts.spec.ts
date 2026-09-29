import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

test.use({ viewport: { width: 1360, height: 1000 }, serviceWorkers: 'block' });

test('wide pen curves retain their fill while drawing and erasing', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
    .fill('Stroke artifacts disposable');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Whiteboard');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Wide strokes');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.locator('.fl-ink-canvas').first()).toBeVisible();
  const categories = page.getByRole('toolbar', {
    name: 'Document tool categories',
  });
  // Live, committed and clipped paths may quantize edge
  // antialiasing differently. Bound that to twelve channel levels in at most
  // one percent of the pixels; holes,
  // shifted edges and width changes produce much larger differences.
  const samePixels = async (a: Buffer, b: Buffer): Promise<boolean> =>
    page.evaluate(
      async ([first, second]) => {
        const pixels = async (encoded: string) => {
          const bitmap = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${encoded}`)).blob(),
          );
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const [x, y] = await Promise.all([pixels(first!), pixels(second!)]);
        if (x.length !== y.length) return false;
        let changedPixels = 0;
        for (let i = 0; i < x.length; i += 4) {
          let changed = false;
          for (let channel = 0; channel < 4; channel++) {
            const difference = Math.abs(x[i + channel]! - y[i + channel]!);
            if (difference > 12) return false;
            changed ||= difference > 0;
          }
          if (changed) changedPixels++;
        }
        return changedPixels <= (x.length / 4) * 0.01;
      },
      [a.toString('base64'), b.toString('base64')],
    );
  const pens = ['Pen', 'Fountain Pen', 'Brush Pen', 'Pencil', 'Highlighter'];
  for (const [index, name] of pens.entries()) {
    const shelf = page.locator(
      `[data-tool-shelf="${name === 'Highlighter' ? 'surface.highlighter' : 'surface.write'}"]`,
    );
    if (!(await shelf.isVisible())) {
      await categories
        .getByRole('button', {
          name: name === 'Highlighter' ? 'Highlighter' : 'Pen',
          exact: true,
        })
        .click();
    }
    await shelf.getByRole('button', { name, exact: true }).click();
    if (await page.getByRole('dialog', { name: /settings$/i }).isVisible())
      await page.keyboard.press('Escape');
    const width = shelf
      .getByRole('group', { name: 'Quick widths' })
      .getByRole('button')
      .first();
    await width.click();
    const widthInput = page.getByRole('spinbutton', {
      name: 'Slot width in points',
    });
    if (!(await widthInput.isVisible())) await width.click();
    await widthInput.fill('40');
    await page.keyboard.press('Escape');
    const y = 300 + index * 120;
    await page.mouse.move(500, y - 10);
    await page.mouse.down();
    for (let i = 1; i <= 50; i++) await page.mouse.move(500 + i * 3, y - 10);
    const start = { x: 490, y: y - 40, width: 80, height: 70 };
    const before = await page.screenshot({
      clip: start,
      path: testInfo.outputPath(`start-before-${index}.png`),
    });
    for (let i = 1; i <= 20; i++) await page.mouse.move(650 + i * 2.5, y - 10);
    for (let i = 1; i <= 240; i++) {
      const angle =
        -Math.PI / 2 + (i * Math.PI * 10 * (index % 2 ? -1 : 1)) / 240;
      await page.mouse.move(
        700 + Math.cos(angle) * 10,
        y + Math.sin(angle) * 10,
      );
    }
    const center = { x: 697, y: y - 3, width: 6, height: 6 };
    const liveCenter = await page.screenshot({ clip: center });
    await page.screenshot({
      path: testInfo.outputPath(`preview-${index}.png`),
    });
    await page.mouse.up();
    await page.mouse.move(20, 20);
    await expect
      .poll(async () =>
        (await page.screenshot({ clip: center })).equals(liveCenter),
      )
      .toBe(true);
    await page.screenshot({
      clip: start,
      path: testInfo.outputPath(`start-after-${index}.png`),
    });
    await expect
      .poll(async () =>
        samePixels(await page.screenshot({ clip: start }), before),
      )
      .toBe(true);
  }
  const stable = { x: 480, y: 260, width: 150, height: 560 };
  const beforeErase = await page.screenshot({
    clip: stable,
    path: testInfo.outputPath('before-erase.png'),
  });
  const erasedArea = { x: 680, y: 270, width: 40, height: 60 };
  const beforeCut = await page.screenshot({ clip: erasedArea });
  await categories.getByRole('button', { name: 'Eraser', exact: true }).click();
  await page
    .getByRole('button', { name: 'Precision Eraser', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await page.mouse.move(700, 270);
  await page.mouse.down();
  await page.mouse.move(700, 330, { steps: 20 });
  await page.mouse.up();
  await page.mouse.move(20, 20);
  await page.screenshot({
    clip: stable,
    path: testInfo.outputPath('after-erase.png'),
  });
  await page.screenshot({ path: testInfo.outputPath('wide-strokes.png') });
  await expect
    .poll(async () =>
      (await page.screenshot({ clip: erasedArea })).equals(beforeCut),
    )
    .toBe(false);
  await expect
    .poll(async () =>
      samePixels(await page.screenshot({ clip: stable }), beforeErase),
    )
    .toBe(true);
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () =>
      (await page.screenshot({ clip: erasedArea })).equals(beforeCut),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      (await page.screenshot({ clip: stable })).equals(beforeErase),
    )
    .toBe(true);
  await page.keyboard.press('Control+s');
  expect(errors).toEqual([]);
});
